// Picks the right YouTube Music result for a CSV row by checking title + duration,
// instead of blindly trusting the first search result. Also formats missing_tracks.txt.
// Put this file next to yt-csv-to-playlist.js and browser-paths.js.

// Bump this when the matching rules change: old "no match" cache entries get searched again.
const MATCHER_VERSION = 1;

const MAX_CANDIDATES = 6; // how many top results to look at
const TOL_EXACT_TITLE = 10; // seconds: identical title, duration may differ this much
const TOL_LOOSE_TITLE = 4; // seconds: similar title, duration must be this close
const TOL_DURATION_ONLY = 1; // seconds: title differs (romanized/translated), but same artist + near-identical length
const TOL_ISRC_WEAK = 1; // seconds: first ISRC result, title+artist in a different writing system (cannot be compared)
const TOL_ISRC_HIT = 2; // seconds: result of an ISRC search must be this close in length AND agree on title, artist or album

//  title helpers

function normalizeTitle(raw) {
  let s = String(raw || "")
    .normalize("NFKC")
    .toLowerCase();
  // strip accents on Latin letters only (í -> i); leaves Japanese voiced marks (ば) alone
  s = s
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC");
  // drop "(feat. X)", "[with Y]", "(from Some Game)" style tags
  s = s.replace(/[(\[]\s*(feat|ft|featuring|with|from)\b[^)\]]*[)\]]/g, " ");
  // drop trailing "- ft. X" / "- Prod by X" credits
  s = s.replace(/\s[-–—]\s*(feat|ft|featuring|prod|produced)\b.*$/g, " ");
  // drop trailing "- 2011 Remaster" style tags
  s = s.replace(
    /\s[-–—]\s*(\d{4}\s*)?(digitally\s+)?remaster(ed)?[^-–—]*$/g,
    " ",
  );
  // keep letters/numbers of any script, turn everything else into spaces
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return s;
}

// "exact"  -> same words
// "loose"  -> one title is the other plus up to 2 extra non-numeric words
// null     -> different titles (numbers matter: "Guy" vs "Guy 2" never match)
// YouTube Music often shows Japanese songs as "日本語タイトル - English/Romaji title".
// If one half of such a title equals ours, it is the same title.
function bilingualMatch(A, rawCandidate) {
  const parts = String(rawCandidate).split(/\s[-–—]\s/);
  if (parts.length < 2) return false;
  const nonAscii = (p) => /[^\x00-\x7F]/.test(p);
  const hasLatinHalf = parts.some((p) => !nonAscii(p) && /\p{L}/u.test(p));
  if (!parts.some(nonAscii) || !hasLatinHalf) return false;
  return parts.some((p) => normalizeTitle(p) === A);
}

function titleMatch(expected, candidate) {
  const A = normalizeTitle(expected);
  const B = normalizeTitle(candidate);
  if (!A || !B) return null;
  if (A === B) return "exact";
  if (bilingualMatch(A, candidate)) return "exact";

  const ta = new Set(A.split(" "));
  const tb = new Set(B.split(" "));
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return null;

  const extra = [...large].filter((t) => !small.has(t));
  if (extra.length > 2 || extra.some((t) => /\d/.test(t))) return null;
  return "loose";
}

function normName(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function textOf(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x.text === "string") return x.text;
  if (Array.isArray(x.runs)) return x.runs.map((r) => r?.text || "").join("");
  if (typeof x.name === "string") return x.name;
  const s = typeof x.toString === "function" ? x.toString() : "";
  return s && s !== "[object Object]" ? s : "";
}

function artistText(song) {
  const direct = [];
  for (const a of song.artists || []) direct.push(textOf(a));
  for (const a of song.authors || []) direct.push(textOf(a));
  direct.push(textOf(song.author));
  const directText = direct.join(" ").trim();
  if (directText) return directText;

  const fallback = [textOf(song.subtitle)];
  (song.flex_columns || [])
    .slice(1)
    .forEach((c) => fallback.push(textOf(c?.title ?? c)));
  return fallback.join(" ");
}

const words = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function artistOverlap(expectedArtists, song) {
  const text = artistText(song);
  const blob = normName(text);
  if (!blob) return false;
  const candWords = new Set(words(text));
  return expectedArtists.some((e) => {
    const n = normName(e);
    if (!n) return false;
    if (blob.includes(n)) return true;
    const ew = words(e);
    return ew.length >= 2 && ew.every((w) => candWords.has(w));
  });
}

const hasNonLatin = (s) =>
  /(?:(?!\p{Script=Latin})\p{L})/u.test(String(s || ""));

const scriptsDiffer = (a, b) => hasNonLatin(a) !== hasNonLatin(b);

function albumOverlap(expectedAlbum, song) {
  const e = normName(expectedAlbum);
  const c = normName(textOf(song?.album));
  if (!e || !c) return false;
  if (e === c) return true;

  return Math.min(e.length, c.length) >= 6 && (e.includes(c) || c.includes(e));
}

function songSeconds(song) {
  const d = song?.duration;
  if (d == null) return null;
  if (typeof d === "number") return d;
  if (typeof d.seconds === "number") return d.seconds;
  const text =
    typeof d.text === "string" ? d.text : typeof d === "string" ? d : null;
  if (text && text.includes(":")) {
    const parts = text.split(":").map(Number);
    if (parts.every((n) => !isNaN(n)))
      return parts.reduce((a, v) => a * 60 + v, 0);
  }
  return null;
}

function expectedSecondsFromRow(row) {
  const key = Object.keys(row).find((k) => /duration|length/i.test(k));
  if (!key || row[key] == null || String(row[key]).trim() === "") return null;
  const raw = String(row[key]).trim();

  if (raw.includes(":")) {
    const parts = raw.split(":").map(Number);
    if (parts.some((n) => isNaN(n))) return null;
    return parts.reduce((a, v) => a * 60 + v, 0);
  }
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  return /ms|milli/i.test(key) || n > 10000 ? n / 1000 : n;
}

function titleOf(song) {
  return String(song?.title?.text ?? song?.title ?? "");
}

function summarizeSong(song) {
  return { id: song.id, title: titleOf(song), seconds: songSeconds(song) };
}

function describe(song) {
  const secs = songSeconds(song);
  return `"${titleOf(song)}"${secs != null ? ` (${Math.round(secs)}s)` : ""}`;
}

let debugShown = false;

function pickBestSong(songs, expected, opts = {}) {
  const cands = (songs || []).slice(0, MAX_CANDIDATES).filter((s) => s && s.id);
  const expectedSeconds = expected.seconds || null;

  if (cands.length === 0) {
    return {
      id: null,
      note: "search returned no songs",
      miss: { kind: "none", expectedSeconds, candidates: [] },
    };
  }

  if (!expected.title && !expected.seconds) {
    return {
      id: cands[0].id,
      reason: "unverified (CSV has no title/duration)",
    };
  }

  // Run with DEBUG_MATCH=1 to see what fields youtubei.js gives.
  if (process.env.DEBUG_MATCH && !debugShown) {
    debugShown = true;
    const s = cands[0];
    console.log(
      "   [DEBUG_MATCH] first result fields:",
      Object.keys(s).join(", "),
    );
    console.log(
      "   [DEBUG_MATCH] title:",
      JSON.stringify(titleOf(s)),
      "| seconds:",
      songSeconds(s),
      "| artist text found:",
      JSON.stringify(artistBlob(s)),
    );
  }

  const accepted = [];
  let closest = null; // right title, wrong length: the best "maybe it's this one" candidate

  cands.forEach((song, rank) => {
    const secs = songSeconds(song);
    const diff =
      secs != null && expected.seconds
        ? Math.abs(secs - expected.seconds)
        : null;
    const tm = expected.title
      ? titleMatch(expected.title, titleOf(song))
      : null;

    const artistMatch = artistOverlap(expected.artists || [], song);
    const albumMatch = albumOverlap(expected.album, song);

    let tier = null;
    // An ISRC search finds the exact recording when YouTube knows the code. It also returns
    // unrelated junk when it doesn't, so a hit still needs near-identical length plus one other
    // signal (title, artist or album) before it is trusted.
    if (
      opts.viaIsrc &&
      diff !== null &&
      diff <= TOL_ISRC_HIT &&
      (tm || artistMatch || albumMatch)
    )
      tier = -1;
    else if (tm === "exact" && (diff === null || diff <= TOL_EXACT_TITLE))
      tier = 0;
    else if (tm === "loose" && diff !== null && diff <= TOL_LOOSE_TITLE)
      tier = 1;
    else if (diff !== null && diff <= TOL_DURATION_ONLY && artistMatch)
      tier = 2;
    // Last resort for ISRC search results only. Title and artist are in a different writing system
    // from the CSV (e.g. "Kengamine" vs 剣ヶ峰), so they cannot be compared at all. Accept only the
    // FIRST result, within 1s of the length, and never a video already returned for another ISRC
    // (YouTube returns the same unrelated "junk" videos for ISRCs it does not know).
    else if (
      opts.viaIsrc &&
      rank === 0 &&
      diff !== null &&
      diff <= TOL_ISRC_WEAK &&
      !(opts.junkIds && opts.junkIds.has(song.id)) &&
      expected.title &&
      scriptsDiffer(expected.title, titleOf(song)) &&
      (!artistText(song).trim() ||
        scriptsDiffer((expected.artists || []).join(" "), artistText(song)))
    )
      tier = 3;

    if (tier !== null) {
      accepted.push({
        song,
        tier,
        diff: diff ?? 0,
        rank,
        noDuration: diff === null,
      });
    } else if (tm && diff !== null && (!closest || diff < closest.diff)) {
      closest = { song, diff };
    }
  });

  if (accepted.length === 0) {
    const want = expected.seconds
      ? `wanted ${Math.round(expected.seconds)}s`
      : "no length to compare";
    const list = cands.map(describe).join(" | ");
    const info = cands.map((s) => ({
      id: s.id,
      title: titleOf(s),
      seconds: songSeconds(s),
    }));
    return {
      id: null,
      note: `none of the ${cands.length} result(s) matched (${want}). Checked: ${list}`,
      miss: {
        kind: closest ? "length" : "other",
        expectedSeconds,
        closest: closest
          ? {
              id: closest.song.id,
              title: titleOf(closest.song),
              seconds: songSeconds(closest.song),
            }
          : null,
        candidates: info,
      },
    };
  }

  accepted.sort(
    (a, b) => a.tier - b.tier || a.diff - b.diff || a.rank - b.rank,
  );
  const best = accepted[0];
  const how = best.noDuration
    ? "title only (no duration to compare)"
    : best.tier === -1
      ? "ISRC hit, length within 2s and title/artist/album agrees"
      : best.tier === 3
        ? "ISRC hit, length within 1s; title/artist are in a different writing system so they could not be compared"
        : ["title + duration", "similar title + duration", "duration + artist"][
            best.tier
          ];
  return {
    id: best.song.id,
    reason: `${how}${best.rank > 0 ? `, result #${best.rank + 1}` : ""}`,
    weak: best.tier === 3,
  };
}

// missing_tracks.txt

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "?:??";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const clip = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const watchLink = (id) => `https://music.youtube.com/watch?v=${id}`;
const searchLink = (q) =>
  `https://music.youtube.com/search?q=${encodeURIComponent(q)}`;

function formatMissingReport(entries, csvName, totalRows) {
  const groups = { length: [], other: [], none: [], plain: [] };
  for (const e of entries) {
    const k = e.miss?.kind;
    if (k === "length") groups.length.push(e);
    else if (k === "other") groups.other.push(e);
    else if (k === "none" || k === "error") groups.none.push(e);
    else groups.plain.push(e);
  }
  groups.length.sort(
    (a, b) =>
      Math.abs(a.miss.closest.seconds - a.miss.expectedSeconds) -
      Math.abs(b.miss.closest.seconds - b.miss.expectedSeconds),
  );

  for (const k of Object.keys(groups)) {
    const merged = new Map();
    for (const e of groups[k]) {
      const key = `${e.label}|${Math.round(e.miss?.expectedSeconds ?? -1)}`;
      if (merged.has(key)) merged.get(key).count++;
      else merged.set(key, { ...e, count: 1 });
    }
    groups[k] = [...merged.values()];
  }
  const nameOf = (e) =>
    e.count > 1 ? `${e.label}   (x${e.count} in your CSV)` : e.label;

  const out = [];
  const line = "=".repeat(64);
  out.push(`MISSING TRACKS: ${entries.length} of ${totalRows}   (${csvName})`);
  out.push(
    "These were NOT added to the playlist.  (add them manually if you want them, if the link doesn't match the song, search it yourself)",
  );
  out.push("");
  out.push("How to read this:");
  out.push(
    "  [1] Same title found, but the length is different. Often the right song",
  );
  out.push(
    "      (a different edit). Open the link, listen, add it by hand if it's right.",
  );
  out.push("  [2] YouTube Music returned songs, but none with this title.");
  out.push(
    '      Look for "<-- same length as yours": that one is often the right song under a',
  );
  out.push(
    "      different title. Otherwise use the search link; it may not be on YouTube Music.",
  );
  out.push("  [3] Search returned nothing or failed. Use the search link.");
  out.push("");

  const header = (n, title, count) => {
    out.push(line);
    out.push(`[${n}] ${title}  (${count})`);
    out.push(line);
  };

  if (groups.length.length) {
    header(
      1,
      "SAME TITLE, DIFFERENT LENGTH - worth a listen",
      groups.length.length,
    );
    for (const e of groups.length) {
      const c = e.miss.closest;
      const d = Math.round(c.seconds - e.miss.expectedSeconds);
      out.push(`* ${nameOf(e)}`);
      out.push(`    Your CSV:     ${fmtTime(e.miss.expectedSeconds)}`);
      out.push(
        `    YouTube has:  ${fmtTime(c.seconds)}  (${Math.abs(d)}s ${d > 0 ? "longer" : "shorter"})  ${clip(c.title)}`,
      );
      out.push(`    Listen:       ${watchLink(c.id)}`);
      out.push("");
    }
  }

  if (groups.other.length) {
    header(2, "NO MATCHING TITLE IN THE RESULTS", groups.other.length);
    for (const e of groups.other) {
      out.push(`* ${nameOf(e)}`);
      out.push(`    Your CSV:     ${fmtTime(e.miss.expectedSeconds)}`);
      const near = (c) =>
        c.seconds != null && Math.abs(c.seconds - e.miss.expectedSeconds) <= 2;
      const shown = e.miss.candidates.filter((c, i) => i < 3 || near(c));
      shown.forEach((c, i) => {
        const flag = near(c) ? "   <-- same length as yours" : "";
        const tag = c.viaIsrc ? "  (ISRC search)" : "";
        out.push(
          `    ${i === 0 ? "Top results:  " : "              "}${fmtTime(c.seconds)}  ${clip(c.title, 46)}${tag}${flag}`,
        );
      });
      const sameLength = e.miss.candidates.find(near); // ISRC results are listed first
      if (sameLength)
        out.push(
          `    Listen:       ${watchLink(sameLength.id)}   (the same-length one)`,
        );
      out.push(`    Search:       ${searchLink(e.label)}`);
      out.push("");
    }
  }

  if (groups.none.length) {
    header(3, "NOTHING FOUND / SEARCH FAILED", groups.none.length);
    for (const e of groups.none) {
      out.push(`* ${nameOf(e)}`);
      if (e.miss?.expectedSeconds)
        out.push(`    Your CSV:     ${fmtTime(e.miss.expectedSeconds)}`);
      out.push(
        `    Why:          ${e.miss?.kind === "error" ? e.note : "YouTube Music returned no songs for this search"}`,
      );
      out.push(`    Search:       ${searchLink(e.label)}`);
      out.push("");
    }
  }

  if (groups.plain.length) {
    header(4, "OTHER", groups.plain.length);
    for (const e of groups.plain) {
      out.push(`* ${nameOf(e)}`);
      if (e.note) out.push(`    ${clip(e.note, 200)}`);
      out.push("");
    }
  }

  return out.join("\n") + "\n";
}

module.exports = {
  MATCHER_VERSION,
  pickBestSong,
  expectedSecondsFromRow,
  formatMissingReport,
  titleMatch,
  normalizeTitle,
  songSeconds,
  summarizeSong,
  albumOverlap,
};
