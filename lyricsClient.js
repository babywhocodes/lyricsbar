import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

const CACHE_MAX = 80;
const TIMEOUT_SECONDS = 6;

export class LyricsClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = TIMEOUT_SECONDS;
        this._cache = new Map();
        this._inflight = new Map();
        this._destroyed = false;
    }

    async getLyrics(title, artist, album, durationSeconds) {
        if (this._destroyed || (!title && !artist)) {
            return null;
        }

        const key = this._cacheKey(title, artist, album, durationSeconds);
        if (this._cache.has(key)) {
            return this._getCached(key);
        }
        if (this._inflight.has(key)) {
            return this._inflight.get(key);
        }

        const request = this._fetchLyrics(title, artist, album, durationSeconds);
        this._inflight.set(key, request);
        try {
            const lyrics = await request;
            if (lyrics && !this._destroyed) {
                this._setCached(key, lyrics);
            }
            return lyrics;
        } finally {
            this._inflight.delete(key);
        }
    }

    destroy() {
        this._destroyed = true;
        this._session.abort();
        this._cache.clear();
        this._inflight.clear();
    }

    _cacheKey(title, artist, album, durationSeconds) {
        return `${title}||${artist}||${album}||${Math.round(durationSeconds || 0)}`;
    }

    _getCached(key) {
        const lyrics = this._cache.get(key);
        this._cache.delete(key);
        this._cache.set(key, lyrics);
        return lyrics;
    }

    _setCached(key, lyrics) {
        if (this._cache.size >= CACHE_MAX) {
            this._cache.delete(this._cache.keys().next().value);
        }
        this._cache.set(key, lyrics);
    }

    async _fetchLyrics(title, artist, album, durationSeconds) {
        const [exact, search] = await Promise.all([
            this._lrclibExact(title, artist, album, durationSeconds),
            this._lrclibSearch(title, artist, durationSeconds),
        ]);
        if (exact) {
            return exact;
        }
        if (search) {
            return search;
        }
        return this._lyricsOvh(title, artist, durationSeconds);
    }

    async _lrclibExact(title, artist, album, durationSeconds) {
        const params = [
            `track_name=${encodeURIComponent(title || '')}`,
            `artist_name=${encodeURIComponent(artist || '')}`,
        ];
        if (album) {
            params.push(`album_name=${encodeURIComponent(album)}`);
        }
        if (durationSeconds > 0) {
            params.push(`duration=${Math.round(durationSeconds)}`);
        }

        try {
            const result = await this._fetchJSON(`https://lrclib.net/api/get?${params.join('&')}`);
            return this._parseLRC(result?.syncedLyrics);
        } catch (_error) {
            return null;
        }
    }

    async _lrclibSearch(title, artist, durationSeconds) {
        const query = encodeURIComponent(`${title || ''} ${artist || ''}`.trim());
        try {
            const results = await this._fetchJSON(`https://lrclib.net/api/search?q=${query}`);
            if (!Array.isArray(results)) {
                return null;
            }

            const candidates = results
                .filter(result => result.syncedLyrics)
                .map(result => ({
                    lyrics: result.syncedLyrics,
                    difference: durationSeconds > 0 && typeof result.duration === 'number'
                        ? Math.abs(result.duration - durationSeconds)
                        : 0,
                    hasDuration: typeof result.duration === 'number',
                }))
                .filter(result => durationSeconds <= 0 ||
                    (result.hasDuration && result.difference <= 5))
                .sort((a, b) => a.difference - b.difference);

            for (const candidate of candidates) {
                const lyrics = this._parseLRC(candidate.lyrics);
                if (lyrics) {
                    return lyrics;
                }
            }
            return null;
        } catch (_error) {
            return null;
        }
    }

    async _lyricsOvh(title, artist, durationSeconds) {
        if (!title || !artist) {
            return null;
        }

        const encode = value => encodeURIComponent(value.trim());
        try {
            const result = await this._fetchJSON(
                `https://api.lyrics.ovh/v1/${encode(artist)}/${encode(title)}`
            );
            if (!result?.lyrics) {
                return null;
            }

            const lines = result.lyrics
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !/^\[.*\]$/.test(line));
            if (lines.length === 0) {
                return null;
            }

            const totalMs = durationSeconds > 10 ? durationSeconds * 1000 : 240_000;
            const stepMs = totalMs / (lines.length + 1);
            return lines.map((text, index) => ({
                time: Math.round(stepMs * (index + 1)),
                text,
            }));
        } catch (_error) {
            return null;
        }
    }

    async _fetchJSON(url) {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', 'Spotline/1.0');
        message.request_headers.append('Accept', 'application/json');

        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_HIGH,
                null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (message.status_code !== 200) {
                            throw new Error(`Lyrics API returned HTTP ${message.status_code}`);
                        }

                        const data = bytes.get_data();
                        if (!data) {
                            throw new Error('Lyrics API returned an empty response');
                        }
                        resolve(JSON.parse(new TextDecoder().decode(data)));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    _parseLRC(lrcText) {
        if (!lrcText) {
            return null;
        }

        const lines = [];
        const timestamp = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;
        for (const rawLine of lrcText.split('\n')) {
            const match = rawLine.match(timestamp);
            if (!match) {
                continue;
            }

            const fractionMs = match[3].length === 2
                ? Number.parseInt(match[3], 10) * 10
                : Number.parseInt(match[3], 10);
            const time = Number.parseInt(match[1], 10) * 60_000 +
                Number.parseInt(match[2], 10) * 1_000 +
                fractionMs;
            const text = match[4].trim();
            if (text) {
                lines.push({ time, text });
            }
        }
        return lines.length > 0 ? lines : null;
    }
}
