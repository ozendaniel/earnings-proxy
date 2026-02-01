import express from "express";

import OpenAI from "openai";



const app = express();



// ---------- Config ----------

const PORT = process.env.PORT || 3000;

const ACTION_API_KEY = process.env.ACTION_API_KEY;

const ALPHAVANTAGE_API_KEY = process.env.ALPHAVANTAGE_API_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;



if (!ALPHAVANTAGE_API_KEY) console.warn("Missing ALPHAVANTAGE_API_KEY");

if (!OPENAI_API_KEY) console.warn("Missing OPENAI_API_KEY");

if (!ACTION_API_KEY) console.warn("Missing ACTION_API_KEY");



const client = new OpenAI({ apiKey: OPENAI_API_KEY });



// Simple in-memory cache to reduce Alpha Vantage calls

// (Cache resets when service restarts — still useful.)

const cache = new Map(); // key -> { expiresAt, value }

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days



function cacheGet(key) {

  const hit = cache.get(key);

  if (!hit) return null;

  if (Date.now() > hit.expiresAt) {

    cache.delete(key);

    return null;

  }

  return hit.value;

}

function cacheSet(key, value) {

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });

}



// ---------- Middleware ----------

function requireActionKey(req, res, next) {

  const key = req.header("x-action-key");

  if (!ACTION_API_KEY || key !== ACTION_API_KEY) {

    return res.status(401).json({ error: "Unauthorized (missing/invalid x-action-key)" });

  }

  next();

}



// ---------- Helpers ----------

async function fetchAlphaVantageTranscript(symbol, quarter) {

  const url = new URL("https://www.alphavantage.co/query");

  url.searchParams.set("function", "EARNINGS_CALL_TRANSCRIPT");

  url.searchParams.set("symbol", symbol);

  url.searchParams.set("quarter", quarter);

  url.searchParams.set("apikey", ALPHAVANTAGE_API_KEY);



  const r = await fetch(url.toString());

  const data = await r.json();



  // Alpha Vantage sometimes returns rate-limit messages in JSON

  // e.g., { "Note": "..." } or { "Information": "..." }

  if (data?.Note || data?.Information || data?.Error) {

    throw new Error(`Alpha Vantage response: ${JSON.stringify(data)}`);

  }



  return data;

}



function pluckTranscriptText(avPayload) {

  // Defensive: Alpha Vantage payload shape can vary.

  // We'll try a few likely fields.

  return (

    avPayload?.transcript ||

    avPayload?.data?.transcript ||

    avPayload?.content ||

    avPayload?.text ||

    ""

  );

}



function toMarkdown(summary) {

  const lines = [];

  lines.push(`## ${summary.company} — ${summary.quarter}`);

  lines.push("");

  lines.push(`**TL;DR:** ${summary.tldr}`);

  lines.push("");

  lines.push(`**Sentiment:** ${summary.sentiment}  \n**Confidence:** ${summary.confidence}`);

  lines.push("");

  lines.push("### KPIs");

if (!summary.kpis || summary.kpis.length === 0) {

  lines.push("- (no KPIs extracted)");

} else {

  for (const k of summary.kpis.slice(0, 12)) {

    lines.push(`- **${k.kpi}:** ${k.value} (${k.period}; ${k.comparison})`);

    lines.push(`  - Evidence: “${k.evidence_quote}”`);

  }

}

lines.push("");

  lines.push("### Key numbers");

  if (summary.key_numbers.length === 0) {

    lines.push("- (none explicitly stated in the transcript)");

  } else {

    for (const k of summary.key_numbers.slice(0, 6)) {

      lines.push(`- **${k.metric}:** ${k.value} — ${k.context}`);

    }

  }

  lines.push("");

  lines.push("### Guidance / outlook");

  if (summary.guidance.length === 0) {

    lines.push("- (no explicit guidance mentioned)");

  } else {

    for (const g of summary.guidance.slice(0, 8)) lines.push(`- ${g}`);

  }

  lines.push("");

  lines.push("### Themes");

  if (summary.themes.length === 0) {
  lines.push("- (none extracted)");

  } else {

    for (const t of summary.themes.slice(0, 5)) {

      lines.push(`- **${t.theme}**`);

      lines.push(`  - Management view: ${t.management_view}`);

      lines.push(`  - Evidence: “${t.evidence_quote}”`);

    }

  }

  lines.push("");

  lines.push("### Q&A highlights");

  if (summary.qa_highlights.length === 0) {

    lines.push("- (none extracted)");

  } else {

    for (const q of summary.qa_highlights.slice(0, 5)) {

      lines.push(`- **${q.question_topic}**`);

      lines.push(`  - Answer: ${q.answer_summary}`);

      lines.push(`  - Evidence: “${q.evidence_quote}”`);

    }

  }

  lines.push("");

  lines.push("### Risks / watchlist");

  if (summary.risks_watchlist.length === 0) {

    lines.push("- (none extracted)");

  } else {

    for (const r of summary.risks_watchlist.slice(0, 8)) lines.push(`- ${r}`);

  }



  return lines.join("\n");

}



async function makeStructuredSummary({ symbol, quarter, transcriptText }) {

  // JSON Schema for maximum consistency

  const jsonSchema = {

    name: "earnings_call_summary",

    schema: {

      type: "object",

      additionalProperties: false,

      properties: {

        company: { type: "string" },

        quarter: { type: "string" },

        tldr: { type: "string" },

        key_numbers: {

          type: "array",

          items: {

            type: "object",

            additionalProperties: false,

            properties: {

              metric: { type: "string" },

              value: { type: "string" },

              context: { type: "string" }

            },

            required: ["metric", "value", "context"]

          }

        },

        kpis: {

  type: "array",

  items: {

    type: "object",

    additionalProperties: false,

    properties: {

      kpi: { type: "string" },

      value: { type: "string" },

      period: { type: "string" },

      comparison: { type: "string" },

      evidence_quote: { type: "string" }

    },

    required: ["kpi", "value", "period", "comparison", "evidence_quote"]

  }

},

        guidance: { type: "array", items: { type: "string" } },

        themes: {

          type: "array",

          items: {

            type: "object",

            additionalProperties: false,

            properties: {

              theme: { type: "string" },

              management_view: { type: "string" },

              evidence_quote: { type: "string" }

            },

            required: ["theme", "management_view", "evidence_quote"]

          }

        },

        qa_highlights: {

          type: "array",

          items: {

            type: "object",

            additionalProperties: false,

            properties: {

              question_topic: { type: "string" },

              answer_summary: { type: "string" },

              evidence_quote: { type: "string" }

            },

            required: ["question_topic", "answer_summary", "evidence_quote"]

          }

        },

        risks_watchlist: { type: "array", items: { type: "string" } },

        sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] },

        confidence: { type: "number", minimum: 0, maximum: 1 }

      },

      required: [

        "company",

        "quarter",

        "tldr",

        "key_numbers",

        "kpis",

        "guidance",

        "themes",

        "qa_highlights",

        "risks_watchlist",

        "sentiment",

        "confidence"

      ]

    }

  };



  const response = await client.responses.create({

    model: "gpt-4.1-mini",

    input: [

      {

        role: "system",

        content:

          "You are a meticulous equity research assistant. " +

          "Use ONLY what is supported by the transcript text. " +

          "Do not guess missing numbers. " +

          "Evidence quotes must be verbatim and <= 25 words. " +

          "KPIs: always include a dedicated KPIs list. If a KPI is not mentioned, include it with value='Not mentioned', period='Not mentioned', comparison='Not mentioned', evidence_quote='Not mentioned'. " +

          "Target at least 11 KPIs when possible (e.g., Revenue, EPS, Gross margin, Operating margin, FCF, Segment/Cloud metric, Guidance, Buybacks/Capital return, Customer growth, Churn, Average Price)."

      },

      {

        role: "user",

        content:

          `Summarize the earnings call transcript for ${symbol} ${quarter}.\n\n` +

          "Return JSON that matches the schema.\n\n" +

          "TRANSCRIPT:\n" +

          transcriptText

      }

    ],

    text: {

      format: {

        type: "json_schema",

        name: jsonSchema.name,

        schema: jsonSchema.schema

      }

    }

  });



  const raw = response.output_text;

  return JSON.parse(raw);

}



// ---------- Routes ----------



app.get("/health", (req, res) => {

  res.json({ ok: true });

});



app.get("/summary", requireActionKey, async (req, res) => {

  try {

    const symbol = String(req.query.symbol || "").toUpperCase().trim();

    const quarter = String(req.query.quarter || "").trim();



    if (!symbol || !quarter) {

      return res.status(400).json({ error: "symbol and quarter are required (e.g., MSFT & 2024Q4)" });

    }

    if (!/^\d{4}Q[1-4]$/.test(quarter)) {

      return res.status(400).json({ error: "quarter must look like 2024Q4" });

    }



    const cacheKey = `${symbol}:${quarter}`;

    const cached = cacheGet(cacheKey);

    if (cached) return res.json(cached);



    const av = await fetchAlphaVantageTranscript(symbol, quarter);

    const transcriptText = pluckTranscriptText(av);



    if (!transcriptText) {

      return res.status(404).json({

        error: "No transcript text found in Alpha Vantage payload for this symbol/quarter.",

        hint: "Try a different quarter, or confirm Alpha Vantage coverage for this company."

      });

    }



    const summary = await makeStructuredSummary({ symbol, quarter, transcriptText });

    const markdown = toMarkdown(summary);



    const payload = { symbol, quarter, markdown, summary };

    cacheSet(cacheKey, payload);

    return res.json(payload);

  } catch (e) {

    return res.status(500).json({ error: String(e?.message || e) });

  }

});



app.listen(PORT, () => {

  console.log(`Server running on port ${PORT}`);

});
