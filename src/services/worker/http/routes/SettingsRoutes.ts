
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { getPackageRoot, paths } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsManager } from '../../SettingsManager.js';
import { getBranchInfo, switchBranch, pullUpdates } from '../../BranchManager.js';
import { ModeManager } from '../../../domain/ModeManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { clearPortCache } from '../../../../shared/worker-utils.js';
import { flushResponseThen } from '../../../server/flushResponseThen.js';

const updateSettingsSchema = z.object({}).passthrough();

const toggleMcpSchema = z.object({
  enabled: z.boolean(),
}).passthrough();

const switchBranchSchema = z.object({
  branch: z.string().min(1),
}).passthrough();

const updateBranchSchema = z.object({}).passthrough();

export class SettingsRoutes extends BaseRouteHandler {
  constructor(
    private settingsManager: SettingsManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/settings', this.handleGetSettings.bind(this));
    app.post('/api/settings', validateBody(updateSettingsSchema), this.handleUpdateSettings.bind(this));

    app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    app.post('/api/mcp/toggle', validateBody(toggleMcpSchema), this.handleToggleMcp.bind(this));

    app.get('/api/branch/status', this.handleGetBranchStatus.bind(this));
    app.post('/api/branch/switch', validateBody(switchBranchSchema), this.handleSwitchBranch.bind(this));
    app.post('/api/branch/update', validateBody(updateBranchSchema), this.handleUpdateBranch.bind(this));
  }

  private handleGetSettings = this.wrapHandler((req: Request, res: Response): void => {
    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    res.json(settings);
  });

  private handleUpdateSettings = this.wrapHandler((req: Request, res: Response): void => {
    const validation = this.validateSettings(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error
      });
      return;
    }

    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    let settings: any = {};

    if (existsSync(settingsPath)) {
      const settingsData = readFileSync(settingsPath, 'utf-8');
      try {
        settings = JSON.parse(settingsData);
      } catch (parseError) {
        const normalizedParseError = parseError instanceof Error ? parseError : new Error(String(parseError));
        logger.error('HTTP', 'Failed to parse settings file', { settingsPath }, normalizedParseError);
        res.status(500).json({
          success: false,
          error: `Settings file is corrupted. Delete ${settingsPath} to reset.`
        });
        return;
      }
    }

    const settingKeys = [
      'LIGHT_MEM_MODEL',
      'LIGHT_MEM_CONTEXT_OBSERVATIONS',
      'LIGHT_MEM_WORKER_PORT',
      'LIGHT_MEM_WORKER_HOST',
      'LIGHT_MEM_CLAUDE_AUTH_METHOD',
      'LIGHT_MEM_DATA_DIR',
      'LIGHT_MEM_LOG_LEVEL',
      'CLAUDE_CODE_PATH',
      'LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS',
      'LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'LIGHT_MEM_CONTEXT_OBSERVATION_TYPES',
      'LIGHT_MEM_CONTEXT_OBSERVATION_CONCEPTS',
      'LIGHT_MEM_CONTEXT_FULL_COUNT',
      'LIGHT_MEM_CONTEXT_FULL_FIELD',
      'LIGHT_MEM_CONTEXT_SESSION_COUNT',
      'LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE',
      'LIGHT_MEM_FOLDER_CLAUDEMD_ENABLED',
    ];

    for (const key of settingKeys) {
      if (req.body[key] !== undefined) {
        settings[key] = req.body[key];
      }
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    clearPortCache();

    logger.info('WORKER', 'Settings updated');
    res.json({ success: true, message: 'Settings updated successfully' });
  });

  private handleGetMcpStatus = this.wrapHandler((req: Request, res: Response): void => {
    const enabled = this.isMcpEnabled();
    res.json({ enabled });
  });

  private handleToggleMcp = this.wrapHandler((req: Request, res: Response): void => {
    const { enabled } = req.body as z.infer<typeof toggleMcpSchema>;

    this.toggleMcp(enabled);
    res.json({ success: true, enabled: this.isMcpEnabled() });
  });

  private handleGetBranchStatus = this.wrapHandler((req: Request, res: Response): void => {
    const info = getBranchInfo();
    res.json(info);
  });

  private handleSwitchBranch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { branch } = req.body as z.infer<typeof switchBranchSchema>;

    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
    if (!allowedBranches.includes(branch)) {
      res.status(400).json({
        success: false,
        error: `Invalid branch. Allowed: ${allowedBranches.join(', ')}`
      });
      return;
    }

    logger.info('WORKER', 'Branch switch requested', { branch });

    const result = await switchBranch(branch);

    if (result.success) {
      flushResponseThen(res, result, () => {
        logger.info('WORKER', 'Restarting worker after branch switch');
      });
    } else {
      res.json(result);
    }
  });

  private handleUpdateBranch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    logger.info('WORKER', 'Branch update requested');

    const result = await pullUpdates();

    if (result.success) {
      flushResponseThen(res, result, () => {
        logger.info('WORKER', 'Restarting worker after branch update');
      });
    } else {
      res.json(result);
    }
  });

  private validateSettings(settings: any): { valid: boolean; error?: string } {
    if (settings.LIGHT_MEM_CLAUDE_AUTH_METHOD) {
      const validClaudeAuthMethods = ['subscription', 'api-key', 'gateway', 'cli'];
      if (!validClaudeAuthMethods.includes(settings.LIGHT_MEM_CLAUDE_AUTH_METHOD)) {
        return { valid: false, error: 'LIGHT_MEM_CLAUDE_AUTH_METHOD must be "subscription", "api-key", "gateway", or "cli"' };
      }
    }

    if (settings.LIGHT_MEM_CONTEXT_OBSERVATIONS) {
      const obsCount = parseInt(settings.LIGHT_MEM_CONTEXT_OBSERVATIONS, 10);
      if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
        return { valid: false, error: 'LIGHT_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200' };
      }
    }

    if (settings.LIGHT_MEM_WORKER_PORT) {
      const port = parseInt(settings.LIGHT_MEM_WORKER_PORT, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return { valid: false, error: 'LIGHT_MEM_WORKER_PORT must be between 1024 and 65535' };
      }
    }

    if (settings.LIGHT_MEM_WORKER_HOST) {
      const host = settings.LIGHT_MEM_WORKER_HOST;
      const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
      if (!validHostPattern.test(host)) {
        return { valid: false, error: 'LIGHT_MEM_WORKER_HOST must be a valid IP address (e.g., 127.0.0.1, 0.0.0.0)' };
      }
    }

    if (settings.LIGHT_MEM_LOG_LEVEL) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];
      if (!validLevels.includes(settings.LIGHT_MEM_LOG_LEVEL.toUpperCase())) {
        return { valid: false, error: 'LIGHT_MEM_LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR, SILENT' };
      }
    }

    const booleanSettings = [
      'LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS',
      'LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE',
    ];

    for (const key of booleanSettings) {
      if (settings[key] && !['true', 'false'].includes(settings[key])) {
        return { valid: false, error: `${key} must be "true" or "false"` };
      }
    }

    if (settings.LIGHT_MEM_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.LIGHT_MEM_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'LIGHT_MEM_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    if (settings.LIGHT_MEM_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.LIGHT_MEM_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'LIGHT_MEM_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    if (settings.LIGHT_MEM_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.LIGHT_MEM_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'LIGHT_MEM_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    return { valid: true };
  }

  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  private toggleMcp(enabled: boolean): void {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

    if (enabled && existsSync(mcpDisabledPath)) {
      renameSync(mcpDisabledPath, mcpPath);
      logger.info('WORKER', 'MCP search server enabled');
    } else if (!enabled && existsSync(mcpPath)) {
      renameSync(mcpPath, mcpDisabledPath);
      logger.info('WORKER', 'MCP search server disabled');
    } else {
      logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
    }
  }

  private ensureSettingsFile(settingsPath: string): void {
    if (!existsSync(settingsPath)) {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      const dir = path.dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
      logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
    }
  }
}
