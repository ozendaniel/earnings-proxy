import express from "express";

import OpenAI from "openai";

import pdfParse from "pdf-parse";

import * as cheerio from "cheerio";



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

// ---- UTI IR fallback (automatic) ----

const UTI_QUARTERLY_REPORTS_URL = "https://investor.uti.edu/quarterly-reports";



function quarterToUtiLabels(quarter) {

  // quarter like "2026Q1"

  // Page uses: year header "2026" and quarter label "Q1"

  const m = String(quarter || "").match(/^(\d{4})Q([1-4])$/);

  if (!m) return null;

  return { year: m[1], qLabel: `Q${m[2]}` };

}

async function fetchPdfText(url) {

  const r = await fetch(url);

  if (!r.ok) throw new Error(`Failed to download PDF (${r.status}) from ${url}`);



  const arrayBuffer = await r.arrayBuffer();

  const buffer = Buffer.from(arrayBuffer);



  const parsed = await pdfParse(buffer);

  return (parsed?.text || "").trim();

}

async function findUtiTranscriptPdfUrlForQuarter(quarter) {

  const labels = quarterToUtiLabels(quarter);

  if (!labels) return "";



  const r = await fetch(UTI_QUARTERLY_REPORTS_URL);

  if (!r.ok) throw new Error(`Failed to fetch UTI quarterly reports (${r.status})`);



  const html = await r.text();

  const $ = cheerio.load(html);



  // Strategy:

  // - Find the year header element that contains the year (e.g. "2026")

  // - From there, find the block that contains the quarter label (e.g. "Q1")

  // - Within that quarter block, find the "Transcript:" label and the next <a> link (PDF)

  //

  // This is resilient to icon-only links because we anchor on the visible "Transcript:" text.

  let pdfUrl = "";



  // Find any element that exactly matches the year label

  const yearNodes = $(`*:contains("${labels.year}")`).filter((_, el) => {

    const t = $(el).text().trim();

    return t === labels.year;

  });



  // If we can't find the year node cleanly, just search the whole page for quarter blocks.

  const searchRoots = yearNodes.length ? yearNodes.toArray().map(el => $(el).parent()) : [$.root()];



  for (const root of searchRoots) {

    // Find a block that contains the quarter label (e.g. "Q1")

    const quarterCandidates = root.find(`*:contains("${labels.qLabel}")`).filter((_, el) => {

      return $(el).text().trim() === labels.qLabel;

    });



    for (const qEl of quarterCandidates.toArray()) {

      // Walk up a bit to capture the whole quarter section

      const section = $(qEl).closest("li, ul, div").parent();

      const transcriptLabel = section.find(`*:contains("Transcript:")`).first();

      if (!transcriptLabel.length) continue;



      // Transcript link is usually near that label in the same section

      const link = transcriptLabel.parent().find("a").first();

      if (!link.length) continue;



      const href = link.attr("href") || "";

      if (!href) continue;



      // Make absolute if needed

      try {

        pdfUrl = new URL(href, UTI_QUARTERLY_REPORTS_URL).toString();

      } catch {

        pdfUrl = href;

      }



      // We expect a PDF

      if (pdfUrl.toLowerCase().includes(".pdf")) return pdfUrl;

      // Sometimes it could be a redirect page that then serves a PDF; still return it.

      return pdfUrl;

    }

  }



  return "";

}



async function fetchUtiTranscriptFallback(quarter) {

  const pdfUrl = await findUtiTranscriptPdfUrlForQuarter(quarter);

  if (!pdfUrl) return "";

  return await fetchPdfText(pdfUrl);

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

let transcriptText = pluckTranscriptText(av);

let transcriptSource = "alphavantage";    



// Automatic UTI fallback to IR transcript PDF

if (symbol === "UTI" && (!transcriptText || !transcriptText.trim())) {

  transcriptText = await fetchUtiTranscriptFallback(quarter);

  if (transcriptText && transcriptText.trim()) transcriptSource = "uti_ir_pdf";

}



if (!transcriptText || !transcriptText.trim()) {

  return res.status(404).json({

    error: "No transcript text found in Alpha Vantage payload for this symbol/quarter.",

    hint: "Try a different quarter, or confirm coverage for this company."

  });

}



    const summary = await makeStructuredSummary({ symbol, quarter, transcriptText });

    const markdown = toMarkdown(summary);



    const payload = { symbol, quarter, transcriptSource, markdown, summary };

    cacheSet(cacheKey, payload);

    return res.json(payload);

  } catch (e) {

    return res.status(500).json({ error: String(e?.message || e) });

  }

});



app.listen(PORT, () => {

  console.log(`Server running on port ${PORT}`);

});
