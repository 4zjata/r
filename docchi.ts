/// <reference path="./seanime-types.d.ts" />

class Provider {
  private readonly apiBase = "https://api.docchi.pl/v1";
  private readonly debugMode = true;

  private log(message: string, ...args: any[]) {
    console.log(`[Docchi] [INFO] ${message}`, ...args);
  }
  private debug(message: string, ...args: any[]) {
    if (this.debugMode) console.log(`[Docchi] [DEBUG] ${message}`, ...args);
  }
  private error(message: string, ...args: any[]) {
    console.error(`[Docchi] [ERROR] ${message}`, ...args);
  }

  getSettings(): Settings {
    return {
      episodeServers: ["cda", "gdrive", "mega", "uqload", "docchi"],
      supportsDub: false,
    };
  }

  async search(opts: SearchOptions): Promise<SearchResult[]> {
    const startTime = Date.now();
    this.log(`Search query: "${opts.query}"`);

    // Docchi API: /series/related/{TITLE/MAL_ID}
    const url = `${this.apiBase}/series/related/${encodeURIComponent(opts.query)}`;
    this.debug(`GET URL: ${url}`);

    try {
      const req = await fetch(url);
      if (!req.ok) {
        this.error(`API Error during search. Status: ${req.status}`);
        return [];
      }

      type DocchiRelatedSeries = {
        slug: string;
        title: string;
        title_en?: string;
        adult_content?: "true" | "false";
      };

      const data = (await req.json()) as DocchiRelatedSeries[];
      if (!Array.isArray(data)) return [];

      const results: SearchResult[] = data
        .filter((item) => typeof item?.slug === "string" && item.slug.length > 0)
        .map((item) => ({
          id: item.slug,
          title: item.title_en && item.title_en.length > 0 ? item.title_en : item.title,
          url: `https://docchi.pl/anime/${item.slug}`,
          subOrDub: "sub",
        }));

      this.log(`Znaleziono ${results.length} wyników w ${Date.now() - startTime}ms`);
      return results;
    } catch (e) {
      this.error("Critical error in search():", e);
      return [];
    }
  }

  async findEpisodes(seriesSlug: string): Promise<EpisodeDetails[]> {
    this.log(`Pobieranie odcinków dla serii: ${seriesSlug}`);

    // Docchi API: /episodes/count/{SLUG}
    const url = `${this.apiBase}/episodes/count/${encodeURIComponent(seriesSlug)}`;
    this.debug(`GET URL: ${url}`);

    try {
      const req = await fetch(url);
      if (!req.ok) throw new Error(`HTTP Error ${req.status}`);

      type DocchiEpisodeCountItem = {
        anime_episode_number: number;
      };

      const data = (await req.json()) as DocchiEpisodeCountItem[];
      if (!Array.isArray(data) || data.length === 0) return [];

      const episodes: EpisodeDetails[] = data
        .map((it) => {
          const num = Number(it.anime_episode_number);
          if (!Number.isFinite(num) || num <= 0) return null;

          const ep: EpisodeDetails = {
            id: `${seriesSlug}:${num}`, // kodujemy SLUG+NUMBER dla findEpisodeServer()
            number: num,
            title: `Odcinek ${num}`,
            url: `https://docchi.pl/anime/${seriesSlug}/${num}`,
          };
          return ep;
        })
        .filter((x): x is EpisodeDetails => x !== null)
        .sort((a, b) => a.number - b.number);

      this.log(`Załadowano ${episodes.length} odcinków.`);
      return episodes;
    } catch (e) {
      this.error("Critical error in findEpisodes():", e);
      return [];
    }
  }

  async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
    this.log(`Szukanie serwera dla Ep ID: ${episode.id}, Preferowany: ${_server}`);

    // episode.id = "{slug}:{number}"
    let slug: string | undefined;
    let epNumber: number | undefined;

    // FIX 1: \d+ zamiast d+
    const m = String(episode.id).match(/^(.+):(\d+)$/);
    if (m) {
      slug = m[1];
      epNumber = Number(m[2]);
    } else {
      // FIX 2: poprawny regex + escapowanie slashy
      const m2 = String(episode.url).match(/\/anime\/([^/]+)\/(\d+)(?:\/|$)/);
      if (m2) {
        slug = m2[1];
        epNumber = Number(m2[2]);
      }
    }

    if (!slug || !epNumber || !Number.isFinite(epNumber)) {
      throw new Error("Invalid episode identifier (missing slug/number).");
    }

    // Docchi API: /episodes/find/{SLUG}/{NUMBER}
    const url = `${this.apiBase}/episodes/find/${encodeURIComponent(slug)}/${epNumber}`;
    this.debug(`GET URL: ${url}`);

    try {
      const req = await fetch(url);
      if (!req.ok) throw new Error(`HTTP Error ${req.status}`);

      type DocchiPlayer = {
        player: string; // URL (embed/strona/bezpośredni)
        player_hosting: string;
      };

      const players = (await req.json()) as DocchiPlayer[];
      if (!Array.isArray(players) || players.length === 0) {
        throw new Error("No players found for this episode");
      }

      const hostKey = (h: string) => (h || "").toLowerCase().trim();

      const preferredOrder = ["cda", "gdrive", "mega", "uqload", "docchi"];
      let selected: DocchiPlayer | undefined;

      if (_server !== "default") {
        const s = hostKey(_server);
        selected = players.find((p) => hostKey(p.player_hosting).includes(s));
      }

      if (!selected) {
        for (const pref of preferredOrder) {
          selected = players.find((p) => hostKey(p.player_hosting).includes(pref));
          if (selected) break;
        }
      }

      if (!selected) selected = players[0];

      let finalUrl = String(selected.player || "").trim();
      if (!finalUrl) throw new Error("Selected player has empty URL");
      if (finalUrl.startsWith("//")) finalUrl = "https:" + finalUrl;

      // Fallback pod mpv/yt-dlp: jeśli to nie jest m3u8, oznacz jako mp4 (spoofing)
      const isM3u8 = finalUrl.includes(".m3u8");
      const finalType: VideoSourceType = isM3u8 ? "m3u8" : "mp4";

      this.log(`Wybrano serwer: ${selected.player_hosting}, URL: ${finalUrl}, Typ: ${finalType}`);

      return {
        server: selected.player_hosting,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
          "Referer": "https://docchi.pl/",
        },
        videoSources: [
          {
            url: finalUrl,
            type: finalType,
            quality: "Auto",
            subtitles: [],
          },
        ],
      };
    } catch (e) {
      this.error("Critical error in findEpisodeServer:", e);
      throw new Error("Failed to extract video link");
    }
  }
}
