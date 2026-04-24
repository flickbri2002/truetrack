// TrueTrack — Backend Server
// Proxies requests to the Anthropic API so the API key stays off the frontend
// Supports text and vision (image) requests
// Run with: node server.cjs

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

// Increase limit to 20mb to handle base64 image payloads
app.use(express.json({ limit: "20mb" }));

// ← Paste your Anthropic API key here
const API_KEY = process.env.ANTHROPIC_API_KEY || "";

app.post("/api/chat", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        ...req.body,
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "API call failed" });
  }
});

app.listen(3001, () => {
  console.log("✅ TrueTrack server running on http://localhost:3001");
});
