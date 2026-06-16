# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## light-mem

Lightweight cross-session memory for Claude Code and OpenCode. Captures
tool-usage observations via lifecycle hooks, compresses them with the Claude
Agent SDK, embeds them in-process (potion-base-8M + BM25 hybrid search), and
injects relevant context into future sessions.

This repository starts from a single root commit; prior history is not retained.
