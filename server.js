const express  = require("express");
const fs       = require("fs");
const path     = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());
app.use(express.static("public"));

/* ══════════════════════════════════════════════════════
   CONFIG — only edit this section
   To move domains: change BASE_URL
══════════════════════════════════════════════════════ */
const PORT     = 3333;
const API_KEY  = "ghhfhHGFHJGUSHU73754886";
const BASE_URL = "https://share.cosmoscraft.net";

const ALLOWED_DOMAINS = [
  "cdntest.cosmoscraft.net",
  "cdn.cosmoscraft.net",
  "cosmoscraft.net",
  "share.cosmoscraft.net"
];

const CACHE_TTL_MS   = 7 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 1;

/* ══════════════════════════════════════════════════════
   PATHS
   cache/nums/  — numbered embeds  (auto-expire 7 days)
   cache/slugs/ — custom slug embeds (never expire)
   embeds.json  — numbered entry DB
   slugs.json   — slug entry DB
══════════════════════════════════════════════════════ */
const PUBLIC_DIR    = path.join(__dirname, "public");
const NUMS_CACHE    = path.join(__dirname, "cache", "nums");
const SLUGS_CACHE   = path.join(__dirname, "cache", "slugs");
const PREVIEW_FILE  = path.join(PUBLIC_DIR, "preview.jpg");
const LOGO_FILE     = path.join(PUBLIC_DIR, "logo.png");
const NUMS_DB_FILE  = path.join(__dirname, "embeds.json");
const SLUGS_DB_FILE = path.join(__dirname, "slugs.json");

// Create cache dirs
for (const d of [NUMS_CACHE, SLUGS_CACHE])
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

/* ══════════════════════════════════════════════════════
   MEDIA TYPE DETECTION
══════════════════════════════════════════════════════ */
const VIDEO_EXTS = new Set([".mp4",".mkv",".webm",".mov",".avi",".flv",".wmv",".m4v",".ts",".m2ts"]);
const IMAGE_EXTS = new Set([".jpg",".jpeg",".png",".gif",".webp",".bmp",".tiff",".avif"]);
const AUDIO_EXTS = new Set([".mp3",".flac",".wav",".ogg",".aac",".m4a",".opus",".wma"]);

function detectType(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (VIDEO_EXTS.has(ext)) return "video";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (AUDIO_EXTS.has(ext)) return "audio";
  } catch {}
  return "video";
}

/* ══════════════════════════════════════════════════════
   CORS
══════════════════════════════════════════════════════ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ══════════════════════════════════════════════════════
   DB — separate files, auto-backup on every write
══════════════════════════════════════════════════════ */
function loadNumsDB() {
  try {
    if (!fs.existsSync(NUMS_DB_FILE)) return { counter: 0, entries: {} };
    const raw = JSON.parse(fs.readFileSync(NUMS_DB_FILE, "utf8"));
    if (!raw.entries) raw.entries = {};
    if (typeof raw.counter !== "number") raw.counter = 0;
    return raw;
  } catch { return { counter: 0, entries: {} }; }
}
function saveNumsDB(db) {
  try { if (fs.existsSync(NUMS_DB_FILE)) fs.copyFileSync(NUMS_DB_FILE, NUMS_DB_FILE + ".bak"); } catch {}
  fs.writeFileSync(NUMS_DB_FILE, JSON.stringify(db, null, 2));
}
function loadSlugsDB() {
  try {
    if (!fs.existsSync(SLUGS_DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(SLUGS_DB_FILE, "utf8"));
  } catch { return {}; }
}
function saveSlugsDB(db) {
  try { if (fs.existsSync(SLUGS_DB_FILE)) fs.copyFileSync(SLUGS_DB_FILE, SLUGS_DB_FILE + ".bak"); } catch {}
  fs.writeFileSync(SLUGS_DB_FILE, JSON.stringify(db, null, 2));
}

/* ══════════════════════════════════════════════════════
   CACHE PATH HELPERS
   Numbered → cache/nums/42.mp4
   Slugs    → cache/slugs/averagehellokittygf.mp4
══════════════════════════════════════════════════════ */
function cacheDir(isSlug)        { return isSlug ? SLUGS_CACHE : NUMS_CACHE; }
function cachePath(key, isSlug)  { return path.join(cacheDir(isSlug), `${key}.mp4`);  }
function cacheImgPath(key, isSlug){ return path.join(cacheDir(isSlug), `${key}.img`); }
function cacheAudPath(key, isSlug){ return path.join(cacheDir(isSlug), `${key}.mp3`); }
function tmpPath(key, isSlug)    { return path.join(cacheDir(isSlug), `${key}.tmp`);  }
function thumbPath(key, isSlug)  { return path.join(cacheDir(isSlug), `${key}.jpg`);  }

function getCachePath(key, mediaType, isSlug) {
  if (mediaType === "image") return cacheImgPath(key, isSlug);
  if (mediaType === "audio") return cacheAudPath(key, isSlug);
  return cachePath(key, isSlug);
}
function isCacheReady(key, mediaType, isSlug) {
  const cp = getCachePath(key, mediaType, isSlug);
  return fs.existsSync(cp) && !fs.existsSync(tmpPath(key, isSlug));
}

/* ══════════════════════════════════════════════════════
   ENTRY RESOLUTION
══════════════════════════════════════════════════════ */
function resolveEntry(param) {
  // Slugs first
  const slugs = loadSlugsDB();
  if (slugs[param]) return { key: param, item: slugs[param], isSlug: true };
  // Numeric
  const n = parseInt(param, 10);
  const nums = loadNumsDB();
  if (!isNaN(n) && nums.entries[n]) return { key: n, item: nums.entries[n], isSlug: false };
  return null;
}

/* ══════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════ */
function requireKey(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"] || req.body?.key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
const rlMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const hits = (rlMap.get(ip) || []).filter(t => now - t < 60_000);
  hits.push(now); rlMap.set(ip, hits);
  if (hits.length > 20) return res.status(429).json({ error: "Rate limit" });
  next();
}
function isDomainAllowed(url) {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
  } catch { return false; }
}

/* ══════════════════════════════════════════════════════
   STARTUP: AUTO-RECOVER + AUTO-MIGRATE
   Runs before server starts — no manual script needed.
   1. Migrates old flat cache/ files into cache/nums/ or cache/slugs/
   2. Rebuilds missing DB entries from cache files on disk
   3. Migrates old embeds.json slugEntries → slugs.json
══════════════════════════════════════════════════════ */
function startupRecovery() {
  console.log("[STARTUP] Running recovery & migration...");
  let nums  = loadNumsDB();
  let slugs = loadSlugsDB();
  let changed = false;

  // ── 1. Migrate old slugEntries from embeds.json → slugs.json ──
  if (nums.slugEntries) {
    for (const [slug, v] of Object.entries(nums.slugEntries)) {
      if (!slugs[slug]) {
        slugs[slug] = v;
        console.log(`[MIGRATE] slugEntries.${slug} → slugs.json`);
        changed = true;
      }
    }
    delete nums.slugEntries;
    delete nums.slugs;
    saveNumsDB(nums);
    saveSlugsDB(slugs);
    nums  = loadNumsDB();
    slugs = loadSlugsDB();
  }

  // ── 2. Migrate old flat cache/ files → cache/nums/ or cache/slugs/ ──
  const oldCacheDir = path.join(__dirname, "cache");
  try {
    const slugKeys = new Set(Object.keys(slugs));
    for (const f of fs.readdirSync(oldCacheDir)) {
      // Skip subdirs and special files
      const fp = path.join(oldCacheDir, f);
      if (fs.statSync(fp).isDirectory()) continue;
      if (f.endsWith(".bak")) continue;
      const ext  = path.extname(f);
      const base = path.basename(f, ext);
      if (![".mp4",".mp3",".img",".jpg",".tmp",".src"].includes(ext)) continue;

      const isSlugFile = isNaN(parseInt(base)) && slugKeys.has(base);
      const destDir    = isSlugFile ? SLUGS_CACHE : NUMS_CACHE;
      const dest       = path.join(destDir, f);
      if (!fs.existsSync(dest)) {
        fs.renameSync(fp, dest);
        console.log(`[MIGRATE] cache/${f} → cache/${isSlugFile?"slugs":"nums"}/${f}`);
        changed = true;
      } else {
        // Already migrated — remove old copy
        try { fs.unlinkSync(fp); } catch {}
      }
    }
  } catch (e) { console.error("[MIGRATE] error:", e.message); }

  // ── 3. Rebuild missing DB entries from cache files ──
  nums  = loadNumsDB();
  slugs = loadSlugsDB();

  // Scan nums cache
  try {
    for (const f of fs.readdirSync(NUMS_CACHE)) {
      const ext  = path.extname(f);
      const base = path.basename(f, ext);
      if (![".mp4",".mp3",".img"].includes(ext)) continue;
      const n = parseInt(base);
      if (isNaN(n) || nums.entries[n]) continue;
      const mediaType = ext===".mp4"?"video":ext===".mp3"?"audio":"image";
      const mtime = (() => { try { return fs.statSync(path.join(NUMS_CACHE,f)).mtimeMs; } catch { return Date.now(); }})();
      nums.entries[n] = { url:`[RECOVERED #${n}]`, mediaType, created:mtime, hits:0, recovered:true };
      if (n > nums.counter) nums.counter = n;
      console.log(`[RECOVER] #${n} [${mediaType}] from cache/nums/`);
      changed = true;
    }
  } catch {}

  // Scan slugs cache
  try {
    for (const f of fs.readdirSync(SLUGS_CACHE)) {
      const ext  = path.extname(f);
      const base = path.basename(f, ext);
      if (![".mp4",".mp3",".img"].includes(ext)) continue;
      if (slugs[base]) continue;
      const mediaType = ext===".mp4"?"video":ext===".mp3"?"audio":"image";
      const mtime = (() => { try { return fs.statSync(path.join(SLUGS_CACHE,f)).mtimeMs; } catch { return Date.now(); }})();
      slugs[base] = { url:`[RECOVERED /${base}]`, mediaType, created:mtime, hits:0, recovered:true };
      console.log(`[RECOVER] slug:${base} [${mediaType}] from cache/slugs/`);
      changed = true;
    }
  } catch {}

  if (changed) {
    saveNumsDB(nums);
    saveSlugsDB(slugs);
    console.log("[STARTUP] Recovery complete — DBs updated.");
  } else {
    console.log("[STARTUP] No recovery needed.");
  }
}

/* ══════════════════════════════════════════════════════
   CACHE TTL CLEANUP
   cache/nums/  → expire files after 7 days of no access
   cache/slugs/ → never expire
══════════════════════════════════════════════════════ */
function cleanupCache() {
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(NUMS_CACHE)) {
      if (f.endsWith(".tmp") || f.endsWith(".src")) continue;
      const fp  = path.join(NUMS_CACHE, f);
      try {
        const age = now - fs.statSync(fp).mtimeMs;
        if (age > CACHE_TTL_MS) {
          fs.unlinkSync(fp);
          console.log(`[CACHE] Expired: nums/${f} (${(age/86400000).toFixed(1)}d)`);
        }
      } catch {}
    }
  } catch {}
  // Slugs cache: never touch
}
setInterval(cleanupCache, 60 * 60 * 1000);

/* ══════════════════════════════════════════════════════
   ENCODE QUEUE
══════════════════════════════════════════════════════ */
const encodes  = new Map();
const encQueue = [];

function processQueue() {
  if (encodes.size >= MAX_CONCURRENT || encQueue.length === 0) return;
  const next = encQueue.shift();
  runEncode(next.key, next.url, next.mediaType, next.isSlug);
}

function startEncode(key, sourceUrl, mediaType, isSlug) {
  if (isCacheReady(key, mediaType, isSlug)) {
    const cp = getCachePath(key, mediaType, isSlug);
    const sz = fs.statSync(cp).size;
    if (sz > 1024) {
      console.log(`[ENCODE] ${key} already cached (${(sz/1048576).toFixed(1)} MB)`);
      if (!isSlug) { const now = Date.now()/1000; try { fs.utimesSync(cp,now,now); } catch {} }
      return;
    }
  }
  if (encodes.has(key) || encQueue.find(q => q.key === key)) return;
  try { if (fs.existsSync(tmpPath(key, isSlug))) fs.unlinkSync(tmpPath(key, isSlug)); } catch {}
  if (encodes.size < MAX_CONCURRENT) runEncode(key, sourceUrl, mediaType, isSlug);
  else { console.log(`[QUEUE] ${key} queued`); encQueue.push({ key, url: sourceUrl, mediaType, isSlug }); }
}

function runEncode(key, sourceUrl, mediaType, isSlug) {
  console.log(`[ENCODE] ${key} start [${mediaType}] [${isSlug?"slug":"num"}]`);
  const state = { done:false, failed:false, tmpBytes:0, progress:"downloading...", mediaType };
  encodes.set(key, state);

  const srcFile  = path.join(cacheDir(isSlug), `${key}.src`);
  const outTmp   = tmpPath(key, isSlug);
  const finalOut = getCachePath(key, mediaType, isSlug);

  const dl = spawn("curl", [
    "-L","--retry","5","--retry-delay","2",
    "--connect-timeout","30","--max-time","3600",
    "-o", srcFile, sourceUrl
  ]);
  dl.stderr.on("data", () => {});

  const dlInterval = setInterval(() => {
    try { if (fs.existsSync(srcFile)) { const sz=fs.statSync(srcFile).size; state.tmpBytes=sz; state.progress=`downloading ${(sz/1048576).toFixed(1)} MB`; } } catch {}
  }, 2000);

  dl.on("close", dlCode => {
    clearInterval(dlInterval);
    if (dlCode !== 0 || !fs.existsSync(srcFile)) {
      state.done = state.failed = true; encodes.delete(key);
      console.error(`[ENCODE] ${key} download failed`);
      try { fs.unlinkSync(srcFile); } catch {}
      processQueue(); return;
    }

    const srcSize = fs.statSync(srcFile).size;
    console.log(`[ENCODE] ${key} downloaded (${(srcSize/1048576).toFixed(1)} MB) — processing`);
    state.tmpBytes = 0; state.progress = "processing...";

    if (mediaType === "image") {
      try {
        fs.copyFileSync(srcFile, outTmp); fs.unlinkSync(srcFile); fs.renameSync(outTmp, finalOut);
        const sz = fs.statSync(finalOut).size;
        state.done=true; state.tmpBytes=sz; encodes.delete(key);
        console.log(`[ENCODE] ${key} image cached (${(sz/1048576).toFixed(1)} MB)`);
      } catch(e) { state.done=state.failed=true; encodes.delete(key); console.error(`[ENCODE] ${key}: ${e.message}`); }
      processQueue(); return;
    }

    const ffArgs = mediaType === "audio" ? [
      "-hide_banner","-loglevel","warning","-i",srcFile,"-threads","0",
      "-c:a","libmp3lame","-q:a","0","-ar","48000","-ac","2",
      "-id3v2_version","3","-f","mp3","-y",outTmp
    ] : [
      "-hide_banner","-loglevel","warning","-i",srcFile,"-threads","0",
      "-c:v","libx264","-preset","fast","-crf","18",
      "-maxrate","8M","-bufsize","16M","-pix_fmt","yuv420p",
      "-g","48","-keyint_min","48","-sc_threshold","0",
      "-c:a","aac","-b:a","192k","-ac","2","-ar","48000",
      "-vf","scale='min(iw,1920)':-2:flags=lanczos",
      "-movflags","+faststart","-f","mp4","-y",outTmp
    ];

    const ff = spawn("ffmpeg", ffArgs);
    ff.stderr.on("data", d => {
      const t = d.toString();
      const m = t.match(/frame=\s*(\d+).*time=(\S+).*speed=(\S+)/);
      const m2 = t.match(/time=(\S+).*bitrate=(\S+)/);
      if (m) state.progress = `frame ${m[1]} time=${m[2]} speed=${m[3]}`;
      else if (m2) state.progress = `time=${m2[1]} bitrate=${m2[2]}`;
      if (m || /error|Error/i.test(t)) process.stdout.write(`[FFMPEG] ${key} ${t.trim()}\n`);
    });

    const szInterval = setInterval(() => {
      try { if (fs.existsSync(outTmp)) state.tmpBytes = fs.statSync(outTmp).size; } catch {}
    }, 1000);

    ff.on("close", code => {
      clearInterval(szInterval); state.done = true; encodes.delete(key);
      try { fs.unlinkSync(srcFile); } catch {}
      if (code === 0) {
        try {
          fs.renameSync(outTmp, finalOut);
          const sz = fs.statSync(finalOut).size;
          state.tmpBytes = sz;
          console.log(`[ENCODE] ${key} done — ${(sz/1048576).toFixed(1)} MB`);
        } catch(e) { state.failed=true; console.error(`[ENCODE] ${key} rename: ${e.message}`); }
      } else {
        state.failed = true;
        console.error(`[ENCODE] ${key} failed (code ${code})`);
        try { fs.unlinkSync(outTmp); } catch {}
      }
      processQueue();
    });

    ff.on("error", e => {
      clearInterval(szInterval); state.done=state.failed=true; encodes.delete(key);
      try { fs.unlinkSync(srcFile); } catch {} try { fs.unlinkSync(outTmp); } catch {}
      console.error(`[ENCODE] spawn: ${e.message}`); processQueue();
    });
  });

  dl.on("error", e => {
    clearInterval(dlInterval); state.done=state.failed=true; encodes.delete(key);
    console.error(`[ENCODE] curl: ${e.message}`); processQueue();
  });
}

/* ══════════════════════════════════════════════════════
   RESUME INCOMPLETE ENCODES ON STARTUP
══════════════════════════════════════════════════════ */
function resumeIncomplete() {
  const nums  = loadNumsDB();
  const slugs = loadSlugsDB();
  for (const [isSlug, dir, db] of [[false, NUMS_CACHE, nums.entries], [true, SLUGS_CACHE, slugs]]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".tmp")) continue;
        const key  = f.replace(".tmp", "");
        const item = isSlug ? db[key] : db[parseInt(key)];
        if (!item || !item.url || item.url.startsWith("[RECOVERED")) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {} continue;
        }
        console.log(`[RESUME] Restarting ${key}`);
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
        try { fs.unlinkSync(path.join(dir, `${key}.src`)); } catch {}
        startEncode(key, item.url, item.mediaType || "video", isSlug);
      }
    } catch {}
  }
}

/* ══════════════════════════════════════════════════════
   STATIC
══════════════════════════════════════════════════════ */
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/preview.jpg", (req, res) => {
  res.setHeader("Content-Type","image/jpeg"); res.setHeader("Cache-Control","public,max-age=3600");
  if (fs.existsSync(PREVIEW_FILE)) return fs.createReadStream(PREVIEW_FILE).pipe(res);
  const ff = spawn("ffmpeg",["-f","lavfi","-i","color=c=#0d1117:size=1280x720:rate=1","-vframes","1","-f","image2","-vcodec","mjpeg","pipe:1"]);
  ff.stderr.on("data",()=>{}); ff.stdout.pipe(res);
});
app.get("/logo.png", (req, res) => {
  if (!fs.existsSync(LOGO_FILE)) return res.status(404).end();
  res.setHeader("Content-Type","image/png"); res.setHeader("Cache-Control","public,max-age=3600");
  fs.createReadStream(LOGO_FILE).pipe(res);
});

const thumbJobs = new Set();
app.get("/thumb/:key", (req, res) => {
  const param    = req.params.key;
  const resolved = resolveEntry(param);
  if (!resolved) return res.status(404).end();
  const { key, item, isSlug } = resolved;
  const mt = item.mediaType || "video";
  const tf = thumbPath(key, isSlug);
  res.setHeader("Content-Type","image/jpeg"); res.setHeader("Cache-Control","public,max-age=86400");

  if (fs.existsSync(tf)) {
    if (!isSlug) { const now=Date.now()/1000; try{fs.utimesSync(tf,now,now);}catch{} }
    return fs.createReadStream(tf).pipe(res);
  }

  const jobKey = `${isSlug?"s":"n"}:${key}`;
  if (mt === "image" && isCacheReady(key,"image",isSlug)) {
    const ff = spawn("ffmpeg",["-i",cacheImgPath(key,isSlug),"-vframes","1",
      "-vf","scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#0d1117",
      "-f","image2","-vcodec","mjpeg","-y",tf]);
    ff.stderr.on("data",()=>{}); ff.on("close",c=>{ if(c===0) fs.createReadStream(tf).pipe(res); }); return;
  }
  if (mt === "audio" && !thumbJobs.has(jobKey)) {
    thumbJobs.add(jobKey);
    const src = isCacheReady(key,"audio",isSlug) ? cacheAudPath(key,isSlug) : item.url;
    const ff = spawn("ffmpeg",["-i",src,"-filter_complex",
      "[0:a]showwavespic=s=620x300:colors=#00d4ff|#7c3aed:split_channels=1[wave];color=s=640x640:color=#0d1117[bg];[bg][wave]overlay=(W-w)/2:(H-h)/2[out]",
      "-map","[out]","-frames:v","1","-f","image2","-vcodec","mjpeg","-y",tf]);
    ff.stderr.on("data",()=>{}); ff.on("close",c=>{ if(c!==0) thumbJobs.delete(jobKey); });
  }
  if (mt === "video" && !thumbJobs.has(jobKey) && item.url && !item.url.startsWith("[RECOVERED")) {
    thumbJobs.add(jobKey);
    const ff = spawn("ffmpeg",["-ss","3","-i",item.url,"-vframes","1",
      "-vf","scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#0d1117",
      "-f","image2","-vcodec","mjpeg","-y",tf]);
    ff.stderr.on("data",()=>{}); ff.on("close",c=>{ if(c===0) console.log(`[THUMB] ${key} done`); else thumbJobs.delete(jobKey); });
  }
  if (fs.existsSync(PREVIEW_FILE)) return fs.createReadStream(PREVIEW_FILE).pipe(res);
  const ff2 = spawn("ffmpeg",["-f","lavfi","-i","color=c=#0d1117:size=1280x720:rate=1","-vframes","1","-f","image2","-vcodec","mjpeg","pipe:1"]);
  ff2.stderr.on("data",()=>{}); ff2.stdout.pipe(res);
});

/* ══════════════════════════════════════════════════════
   /ready/:key — SSE status
══════════════════════════════════════════════════════ */
app.get("/ready/:key", (req, res) => {
  const resolved = resolveEntry(req.params.key);
  if (!resolved) return res.status(404).json({ error:"not found" });
  const { key, item, isSlug } = resolved;
  const mt = item.mediaType || "video";

  function getStatus() {
    const enc   = encodes.get(key);
    const qpos  = encQueue.findIndex(q => q.key === key);
    const ready = isCacheReady(key, mt, isSlug);
    const cp    = getCachePath(key, mt, isSlug);
    const bytes = enc ? enc.tmpBytes : fs.existsSync(cp) ? fs.statSync(cp).size : 0;
    return {
      key, ready, mediaType: mt, isSlug,
      encoding: !!enc, queued: qpos>=0, queuePos: qpos>=0?qpos+1:0,
      cacheBytes: bytes, progress: enc?enc.progress:null,
      message: ready ? "✅ Ready — paste the link into Discord now!"
        : enc    ? `⏳ ${mt==="image"?"Processing":"Encoding"}... ${(bytes/1048576).toFixed(1)} MB (${enc.progress})`
        : qpos>=0 ? `🕐 Queued — position ${qpos+1}`
        : "⏳ Starting..."
    };
  }

  if (!req.headers.accept?.includes("text/event-stream")) return res.json(getStatus());
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();
  let iv;
  const send = () => {
    const s = getStatus();
    res.write(`data: ${JSON.stringify(s)}\n\n`);
    if (s.ready) { res.end(); clearInterval(iv); }
  };
  send();
  iv = setInterval(send, 2000);
  req.on("close", () => clearInterval(iv));
});

/* ══════════════════════════════════════════════════════
   API — CHECK SLUG
══════════════════════════════════════════════════════ */
app.get("/api/check-slug", requireKey, (req, res) => {
  const slug = (req.query.slug||"").trim().toLowerCase();
  if (!slug) return res.json({ available:false, error:"No slug" });
  if (!/^[a-z0-9_-]{2,50}$/.test(slug)) return res.json({ available:false, error:"Invalid format" });
  const reserved = ["ready","api","thumb","preview.jpg","logo.png","favicon.ico","public","media","v"];
  if (reserved.includes(slug)) return res.json({ available:false, error:"Reserved" });
  if (/^\d+$/.test(slug)) return res.json({ available:false, error:"Cannot be a number" });
  const slugs = loadSlugsDB();
  res.json({ available:!slugs[slug], slug });
});

/* ══════════════════════════════════════════════════════
   API — CREATE
══════════════════════════════════════════════════════ */
app.post("/api/create", requireKey, rateLimit, (req, res) => {
  const { url, slug: rawSlug } = req.body;
  if (!url||typeof url!=="string") return res.status(400).json({ error:"No URL" });
  if (!isDomainAllowed(url)) return res.status(403).json({ error:"Domain not whitelisted" });
  const mediaType = detectType(url);

  // ── Custom slug ──────────────────────────────────────
  if (rawSlug && rawSlug.trim()) {
    const slug = rawSlug.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,50}$/.test(slug)) return res.status(400).json({ error:"Slug: 2-50 chars, letters/numbers/hyphens/underscores" });
    const reserved = ["ready","api","thumb","preview.jpg","logo.png","favicon.ico","public","media","v"];
    if (reserved.includes(slug)) return res.status(400).json({ error:"Slug is reserved" });
    if (/^\d+$/.test(slug)) return res.status(400).json({ error:"Slug cannot be a number" });
    const slugs = loadSlugsDB();
    if (slugs[slug]) return res.status(409).json({ error:"Slug already taken" });

    slugs[slug] = { url, mediaType, created:Date.now(), hits:0 };
    saveSlugsDB(slugs);
    console.log(`[CREATE] slug:${slug} [${mediaType}] → ${url}`);

    setImmediate(() => {
      startEncode(slug, url, mediaType, true);
      if (mediaType==="video" && !fs.existsSync(thumbPath(slug,true)) && !thumbJobs.has(`s:${slug}`)) {
        thumbJobs.add(`s:${slug}`);
        const ff = spawn("ffmpeg",["-ss","3","-i",url,"-vframes","1",
          "-vf","scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#0d1117",
          "-f","image2","-vcodec","mjpeg","-y",thumbPath(slug,true)]);
        ff.stderr.on("data",()=>{}); ff.on("close",c=>{ if(c===0) console.log(`[THUMB] ${slug} done`); else thumbJobs.delete(`s:${slug}`); });
      }
    });

    return res.json({
      slug, mediaType, isSlug:true,
      embedUrl:    `${BASE_URL}/${slug}`,
      readyUrl:    `${BASE_URL}/ready/${slug}`,
      downloadUrl: `${BASE_URL}/${slug}/download`,
    });
  }

  // ── Auto-numbered ────────────────────────────────────
  const db = loadNumsDB();
  db.counter = (db.counter||0) + 1;
  const num = db.counter;
  db.entries[num] = { url, mediaType, created:Date.now(), hits:0 };
  saveNumsDB(db);
  console.log(`[CREATE] #${num} [${mediaType}] → ${url}`);

  setImmediate(() => {
    startEncode(num, url, mediaType, false);
    if (mediaType==="video" && !fs.existsSync(thumbPath(num,false)) && !thumbJobs.has(`n:${num}`)) {
      thumbJobs.add(`n:${num}`);
      const ff = spawn("ffmpeg",["-ss","3","-i",url,"-vframes","1",
        "-vf","scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#0d1117",
        "-f","image2","-vcodec","mjpeg","-y",thumbPath(num,false)]);
      ff.stderr.on("data",()=>{}); ff.on("close",c=>{ if(c===0) console.log(`[THUMB] #${num} done`); else thumbJobs.delete(`n:${num}`); });
    }
  });

  return res.json({
    num, slug:String(num), mediaType, isSlug:false,
    embedUrl:    `${BASE_URL}/${num}`,
    readyUrl:    `${BASE_URL}/ready/${num}`,
    downloadUrl: `${BASE_URL}/${num}/download`,
  });
});

/* ══════════════════════════════════════════════════════
   OG EMBED PAGE /:key
══════════════════════════════════════════════════════ */
function embedHandler(req, res) {
  const resolved = resolveEntry(req.params.key);
  if (!resolved) return res.status(404).send("Not found");
  const { key, item, isSlug } = resolved;
  const mt       = item.mediaType || "video";
  const thumbUrl = `${BASE_URL}/thumb/${key}`;
  const dlUrl    = `${BASE_URL}/${key}/download`;
  const srcUrl   = (() => { try { return decodeURIComponent(item.url); } catch { return item.url; }})();
  const disclaimer = "CosmosCraft Network · ⚠️ Cache expires in 7 days · Click title for original file";

  console.log(`[EMBED] ${key} [${mt}] ← ${(req.headers["user-agent"]||"").slice(0,80)}`);

  let ogTags = "", bodyContent = "";

  if (mt === "video") {
    ogTags = `
<meta property="og:site_name"        content="${disclaimer}">
<meta property="og:title"            content="${srcUrl}">
<meta property="og:type"             content="video.other">
<meta property="og:image"            content="${thumbUrl}">
<meta property="og:video:url"        content="${dlUrl}">
<meta property="og:video:secure_url" content="${dlUrl}">
<meta property="og:video:type"       content="video/mp4">
<meta property="og:video:width"      content="1280">
<meta property="og:video:height"     content="720">
<meta name="theme-color"             content="#00d4ff">`;
    bodyContent = `
  <img src="${thumbUrl}" style="max-width:100%;border-radius:12px;display:block;margin:0 auto 20px;" onerror="this.src='${BASE_URL}/preview.jpg';this.onerror=null">
  <h2 style="color:#00d4ff;margin:0 0 8px;">CosmosCraft Shared Video</h2>
  <a href="${dlUrl}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#7c3aed,#00d4ff);color:white;border-radius:8px;text-decoration:none;font-weight:bold;margin-bottom:20px;">▶ Play Video</a>`;

  } else if (mt === "image") {
    ogTags = `
<meta property="og:site_name"        content="${disclaimer}">
<meta property="og:title"            content="${srcUrl}">
<meta property="og:type"             content="website">
<meta property="og:url"              content="${BASE_URL}/${key}">
<meta property="og:image"            content="${dlUrl}">
<meta property="og:image:secure_url" content="${dlUrl}">
<meta name="twitter:card"            content="summary_large_image">
<meta name="twitter:title"           content="${srcUrl}">
<meta name="twitter:image"           content="${dlUrl}">
<meta name="theme-color"             content="#00d4ff">`;
    bodyContent = `
  <img src="${dlUrl}" style="max-width:100%;max-height:80vh;border-radius:12px;display:block;margin:0 auto 20px;object-fit:contain;" onerror="this.src='${BASE_URL}/preview.jpg';this.onerror=null">
  <h2 style="color:#00d4ff;margin:0 0 8px;">CosmosCraft Shared Image</h2>
  <a href="${dlUrl}" download style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#7c3aed,#00d4ff);color:white;border-radius:8px;text-decoration:none;font-weight:bold;margin-bottom:20px;">⬇ Download Image</a>`;

  } else {
    const audioFilename = (() => { try { return decodeURIComponent(new URL(item.url).pathname.split("/").pop())||"Audio File"; } catch { return "Audio File"; }})();
    ogTags = `
<meta property="og:site_name"        content="CosmosCraft Network">
<meta property="og:title"            content="${audioFilename}">
<meta property="og:type"             content="music.song">
<meta property="og:url"              content="${BASE_URL}/${key}">
<meta property="og:description"      content="Open in browser to play.&#10;&#10;🔇 Discord only allows audio playback for whitelisted providers (Spotify, SoundCloud, etc).&#10;&#10;⚠️ Cache expires in 7 days — original: ${srcUrl}">
<meta property="og:image"            content="${thumbUrl}">
<meta property="og:image:secure_url" content="${thumbUrl}">
<meta property="og:image:width"      content="640">
<meta property="og:image:height"     content="640">
<meta property="og:audio"            content="${dlUrl}">
<meta property="og:audio:type"       content="audio/mpeg">
<meta name="theme-color"             content="#7c3aed">`;
    bodyContent = `
  <h2 style="color:#00d4ff;margin:0 0 12px;">CosmosCraft Shared Audio</h2>
  <img src="${thumbUrl}" style="max-width:320px;border-radius:12px;display:block;margin:0 auto 16px;box-shadow:0 0 32px rgba(0,212,255,.3);" onerror="this.src='${BASE_URL}/preview.jpg';this.onerror=null">
  <div style="margin-bottom:16px;padding:12px 16px;background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);border-radius:8px;font-size:13px;color:#a78bfa;text-align:left;max-width:640px;margin-left:auto;margin-right:auto;">
    <strong>🔇 Why can't I hear this in Discord?</strong><br>
    Discord only allows inline audio playback for whitelisted providers like Spotify and SoundCloud. Open this link in your browser to play it below.
  </div>
  <audio controls style="width:100%;max-width:640px;display:block;margin:0 auto 20px;accent-color:#00d4ff;">
    <source src="${dlUrl}" type="audio/mpeg">
  </audio>
  <a href="${dlUrl}" download style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#7c3aed,#00d4ff);color:white;border-radius:8px;text-decoration:none;font-weight:bold;margin-bottom:20px;">⬇ Download Audio</a>`;
  }

  res.setHeader("Content-Type","text/html;charset=utf-8");
  res.send(`<!DOCTYPE html>
<html><head><title>CosmosCraft Shared File</title>${ogTags}</head>
<body style="margin:0;background:#0b0b0f;color:white;font-family:Arial,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;box-sizing:border-box;">
<div style="text-align:center;max-width:700px;width:100%;">
  ${bodyContent}
  <div style="margin-top:16px;padding:14px 20px;background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.25);border-radius:8px;font-size:13px;color:#f59e0b;line-height:1.7;text-align:left;">
    <strong>⏳ Cached copy expires in 7 days.</strong><br>
    After expiry this embed may no longer work. Use the original link below to access the file permanently.
  </div>
  <div style="margin-top:12px;padding:14px 20px;background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.15);border-radius:8px;text-align:left;">
    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:6px;">Original Source File</div>
    <a href="${srcUrl}" style="color:#00d4ff;font-size:13px;word-break:break-all;text-decoration:none;">${srcUrl}</a>
  </div>
</div>
</body></html>`);
}

app.get("/:key", embedHandler);

/* ══════════════════════════════════════════════════════
   /:key/download
══════════════════════════════════════════════════════ */
app.get("/:key/download", (req, res) => {
  const resolved = resolveEntry(req.params.key);
  if (!resolved) return res.status(404).send("Not found");
  const { key, item, isSlug } = resolved;
  const mt    = item.mediaType || "video";
  const cp    = getCachePath(key, mt, isSlug);
  const range = req.headers.range;
  console.log(`[DOWNLOAD] ${key} [${mt}] range=${range||"none"} ← ${(req.headers["user-agent"]||"").slice(0,60)}`);

  if (isCacheReady(key, mt, isSlug)) {
    if (!isSlug) { const now=Date.now()/1000; try{fs.utimesSync(cp,now,now);}catch{} }
    // Update hits
    if (isSlug) { const s=loadSlugsDB(); if(s[key]){s[key].hits=(s[key].hits||0)+1;saveSlugsDB(s);} }
    else { const d=loadNumsDB(); if(d.entries[key]){d.entries[key].hits=(d.entries[key].hits||0)+1;saveNumsDB(d);} }

    const size = fs.statSync(cp).size;
    const mime = mt==="video"?"video/mp4":mt==="audio"?"audio/mpeg":
      (()=>{ try{const e=path.extname(new URL(item.url).pathname).toLowerCase();
        return {".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",
          ".gif":"image/gif",".webp":"image/webp",".bmp":"image/bmp"}[e]||"application/octet-stream";}catch{return "application/octet-stream";}})();
    const origName = (()=>{ try{return decodeURIComponent(new URL(item.url).pathname.split("/").pop());}catch{return "file";}})();
    const dlName   = mt==="audio"?origName.replace(/\.[^.]+$/,".mp3"):mt==="video"?origName.replace(/\.[^.]+$/,".mp4"):origName;

    res.setHeader("Content-Type",        mime);
    res.setHeader("Content-Disposition", `inline; filename="${dlName.replace(/"/g,"'")}"`);
    res.setHeader("Accept-Ranges",       "bytes");
    res.setHeader("Cache-Control",       "public,max-age=86400");

    if (range) {
      const [s,e] = range.replace(/bytes=/,"").split("-");
      const start = parseInt(s,10), end = e?parseInt(e,10):size-1;
      res.setHeader("Content-Range",  `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", end-start+1);
      res.status(206);
      return fs.createReadStream(cp,{start,end}).pipe(res);
    }
    res.setHeader("Content-Length", size);
    return fs.createReadStream(cp).pipe(res);
  }

  if (!encodes.has(key) && !encQueue.find(q=>q.key===key) && item.url && !item.url.startsWith("[RECOVERED"))
    startEncode(key, item.url, mt, isSlug);

  const enc  = encodes.get(key);
  const qpos = encQueue.findIndex(q=>q.key===key);
  res.status(503).send(item.url?.startsWith("[RECOVERED") ? "Original URL unknown — please re-generate this embed."
    : enc ? `Encoding in progress (${(enc.tmpBytes/1048576).toFixed(1)} MB so far)`
    : qpos>=0 ? `Queued at position ${qpos+1}` : "Starting...");
});

/* ══════════════════════════════════════════════════════
   ADMIN
══════════════════════════════════════════════════════ */
app.get("/api/info", (req, res) => res.json({ baseUrl:BASE_URL, version:"2.1" }));

app.get("/api/list", requireKey, (req, res) => {
  const db    = loadNumsDB();
  const slugs = loadSlugsDB();
  res.json({
    totalNumbered: db.counter,
    totalSlugs: Object.keys(slugs).length,
    slugs: Object.entries(slugs).map(([slug,v]) => ({
      slug, url:v.url, mediaType:v.mediaType, hits:v.hits||0,
      created: new Date(v.created).toISOString(),
      cached: isCacheReady(slug,v.mediaType,true), permanent:true, recovered:!!v.recovered
    })),
    entries: Object.entries(db.entries||{}).map(([n,v]) => {
      const num=parseInt(n), cp=getCachePath(num,v.mediaType||"video",false);
      const age = fs.existsSync(cp)?Date.now()-fs.statSync(cp).mtimeMs:null;
      return { num, url:v.url, mediaType:v.mediaType||"video", hits:v.hits||0,
        created: new Date(v.created).toISOString(),
        cached: isCacheReady(num,v.mediaType||"video",false), recovered:!!v.recovered,
        expiresIn: age!==null?`${Math.max(0,(CACHE_TTL_MS-age)/86400000).toFixed(1)} days`:"n/a" };
    }).sort((a,b)=>b.num-a.num)
  });
});

app.delete("/api/cache/:key", requireKey, (req, res) => {
  const key = req.params.key;
  const resolved = resolveEntry(key);
  const dir = resolved ? cacheDir(resolved.isSlug) : NUMS_CACHE;
  [".mp4",".mp3",".img",".jpg",".tmp",".src"].forEach(ext => {
    const f = path.join(dir, `${key}${ext}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
  res.json({ deleted:true });
});

/* ══════════════════════════════════════════════════════
   START
══════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  // Run recovery FIRST before accepting connections
  startupRecovery();
  const db    = loadNumsDB();
  const slugs = loadSlugsDB();
  console.log("╔════════════════════════════════════════╗");
  console.log("║   CosmosCraft Embed Server  v2.1       ║");
  console.log("╚════════════════════════════════════════╝");
  console.log(`  Domain:   ${BASE_URL}`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Numbered: ${db.counter} entries → cache/nums/   (7-day TTL)`);
  console.log(`  Slugs:    ${Object.keys(slugs).length} entries → cache/slugs/ (permanent)`);
  console.log(`  preview:  ${fs.existsSync(PREVIEW_FILE)?"✓":"✗ MISSING"}`);
  resumeIncomplete();
  cleanupCache();
});