import type { MovieSearchResult } from "../shared/visualization.js";

export class MovieSearchUnavailableError extends Error {
  constructor() {
    super("Movie search is not configured. Add an approved TMDb Read Access Token before using external search.");
    this.name = "MovieSearchUnavailableError";
  }
}

export class MovieSearchProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MovieSearchProviderError";
  }
}

export interface MovieSearchAdapter {
  search(query: string, language: string): Promise<MovieSearchResult[]>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type TmdbMovieRecord = {
  id?: unknown;
  title?: unknown;
  original_title?: unknown;
  release_date?: unknown;
  overview?: unknown;
  poster_path?: unknown;
};

/** Official TMDb v3 movie-search adapter. It is injectable and never configured by default. */
export class TmdbMovieSearchAdapter implements MovieSearchAdapter {
  constructor(private readonly accessToken: string, private readonly fetcher: FetchLike = fetch) {
    if (!accessToken.trim()) throw new MovieSearchUnavailableError();
  }

  async search(query: string, language: string): Promise<MovieSearchResult[]> {
    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("query", query);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("language", language);
    url.searchParams.set("page", "1");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new MovieSearchProviderError("TMDb could not be reached.");
    }
    if (!response.ok) throw new MovieSearchProviderError(`TMDb search failed with status ${response.status}.`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new MovieSearchProviderError("TMDb returned an unreadable response."); }
    if (!body || typeof body !== "object" || !Array.isArray((body as { results?: unknown }).results)) {
      throw new MovieSearchProviderError("TMDb returned an unexpected search response.");
    }
    return ((body as { results: TmdbMovieRecord[] }).results).slice(0, 20).flatMap((movie) => {
      if (!Number.isSafeInteger(movie.id) || typeof movie.title !== "string" || !movie.title.trim()) return [];
      const releaseDate = typeof movie.release_date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(movie.release_date)
        ? movie.release_date
        : null;
      return [{
        id: Number(movie.id),
        title: movie.title.slice(0, 180),
        originalTitle: typeof movie.original_title === "string" ? movie.original_title.slice(0, 180) : movie.title.slice(0, 180),
        releaseDate,
        overview: typeof movie.overview === "string" ? movie.overview.slice(0, 1_000) : "",
        posterPath: typeof movie.poster_path === "string" && /^\/[A-Za-z0-9_./-]{1,150}$/u.test(movie.poster_path) ? movie.poster_path : null,
      }];
    });
  }
}
