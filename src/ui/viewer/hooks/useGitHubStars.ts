export interface GitHubStarsData {
  stargazers_count: number;
}

export interface UseGitHubStarsReturn {
  stars: number | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Privacy: the live star-count fetch to api.github.com was removed so the
 * viewer makes no outbound request to any non-local host. The button still
 * renders as a static link to the repo; it just never shows a live count.
 */
export function useGitHubStars(_username: string, _repo: string): UseGitHubStarsReturn {
  return { stars: null, isLoading: false, error: null };
}
