const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// Invidious instances (ordered by reliability)
// =====================
const INSTANCES = [
  "https://yewtu.be",
  "https://invidious.nerdvpn.de",
  "https://invidious.projectsegfau.lt",
  "https://inv.bp.projectsegfau.lt",
  "https://invidious.fdn.fr"
];

let activeInstance = null;
let instanceCheckTime = 0;
const INSTANCE_TTL = 5 * 60 * 1000; // re-check every 5 minutes

// =====================
// CORS — allow browser requests from any origin (localhost or file://)
// =====================
app.use(cors());

// =====================
// Serve static frontend files
// =====================
app.use(express.static(path.join(__dirname, "public")));

// =====================
// Helper: fetch from a URL with timeout
// =====================
function fetchUrl(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; YTProxy/1.0)",
        "Accept": "application/json"
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, text: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.on("error", reject);
  });
}

// =====================
// Pick a working Invidious instance
// =====================
async function getActiveInstance() {
  const now = Date.now();
  if (activeInstance && now - instanceCheckTime < INSTANCE_TTL) {
    return activeInstance;
  }

  console.log("🔍 Checking Invidious instances...");
  for (const inst of INSTANCES) {
    try {
      const result = await fetchUrl(`${inst}/api/v1/trending?page=1`, 5000);
      JSON.parse(result.text); // make sure it's valid JSON
      activeInstance = inst;
      instanceCheckTime = now;
      console.log(`✅ Using instance: ${inst}`);
      return inst;
    } catch (e) {
      console.log(`❌ ${inst} — ${e.message}`);
    }
  }

  throw new Error("All Invidious instances are currently unavailable.");
}

// =====================
// Proxy middleware
// =====================
async function proxy(req, res) {
  try {
    const instance = await getActiveInstance();

    // Build the path: strip /api prefix that the frontend uses
    const apiPath = req.originalUrl; // e.g. /api/v1/trending?page=1
    const url = instance + apiPath;

    console.log(`→ ${url}`);
    const result = await fetchUrl(url);

    res.setHeader("Content-Type", "application/json");
    res.send(result.text);
  } catch (e) {
    console.error("Proxy error:", e.message);
    res.status(502).json({ error: e.message });
  }
}

// =====================
// Routes — proxy all /api/* requests to Invidious
// =====================
app.get("/api/*", proxy);

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
  console.log(`\n🚀 YT Proxy running at http://localhost:${PORT}`);
  console.log(`📁 Serving frontend from: ${path.join(__dirname, "public")}`);
  console.log(`🔗 Open http://localhost:${PORT} in your browser\n`);
  // Pre-warm instance selection
  getActiveInstance().catch(() => {});
});
