const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// =====================
// Helper: HTTP/HTTPS fetch with timeout
// =====================
function fetchUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
      }
    };
    const req = lib.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, text: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

// =====================
// Fetch working instances dynamically from api.invidious.io
// =====================
let activeInstance = null;
let instanceCheckTime = 0;
const INSTANCE_TTL = 3 * 60 * 1000;

// Fallback hardcoded list
const FALLBACK_INSTANCES = [
  "https://yewtu.be",
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net"
];

async function fetchInstanceList() {
  try {
    const result = await fetchUrl("https://api.invidious.io/instances.json?sort_by=health", 8000);
    const list = JSON.parse(result.text);
    // Filter: only https, cors enabled if possible
    const instances = list
      .filter(([, info]) => info.uri && info.uri.startsWith("https") && info.api === true)
      .map(([, info]) => info.uri.replace(/\/$/, ""))
      .slice(0, 10);
    console.log(`📋 Got ${instances.length} instances from api.invidious.io`);
    return instances.length > 0 ? instances : FALLBACK_INSTANCES;
  } catch (e) {
    console.log(`⚠️ Could not fetch instance list: ${e.message}, using fallback`);
    return FALLBACK_INSTANCES;
  }
}

async function getActiveInstance() {
  const now = Date.now();
  if (activeInstance && now - instanceCheckTime < INSTANCE_TTL) {
    return activeInstance;
  }

  console.log("🔍 Finding working Invidious instance...");
  const instances = await fetchInstanceList();

  for (const inst of instances) {
    try {
      const result = await fetchUrl(`${inst}/api/v1/trending?page=1`, 7000);
      const json = JSON.parse(result.text);
      if (Array.isArray(json) && json.length > 0) {
        activeInstance = inst;
        instanceCheckTime = now;
        console.log(`✅ Using: ${inst}`);
        return inst;
      }
    } catch (e) {
      console.log(`❌ ${inst} — ${e.message}`);
    }
  }
  throw new Error("All Invidious instances are currently unavailable.");
}

// =====================
// Proxy all /api/* requests
// =====================
app.get("/api/*", async (req, res) => {
  try {
    const instance = await getActiveInstance();
    const url = instance + req.originalUrl;
    console.log(`→ ${url}`);
    const result = await fetchUrl(url, 12000);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Proxied-From", instance);
    res.send(result.text);
  } catch (e) {
    console.error("Proxy error:", e.message);
    activeInstance = null; // reset so next request retries
    res.status(502).json({ error: e.message });
  }
});

// =====================
// Health check
// =====================
app.get("/health", async (req, res) => {
  try {
    const inst = await getActiveInstance();
    res.json({ status: "ok", instance: inst });
  } catch (e) {
    res.status(503).json({ status: "error", message: e.message });
  }
});

// =====================
// Start
// =====================
app.listen(PORT, () => {
  console.log(`\n🚀 YT Proxy running on port ${PORT}`);
  getActiveInstance().catch(e => console.error("Startup check failed:", e.message));
});
