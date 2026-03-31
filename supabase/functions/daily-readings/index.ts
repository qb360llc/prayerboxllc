const FEED_URL = "https://bible.usccb.org/readings.rss";

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers": "content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function json(request: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
    },
    status,
  });
}

function matchTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  if (request.method !== "GET") {
    return json(request, 405, { error: "Method not allowed.", ok: false });
  }

  try {
    const response = await fetch(FEED_URL, {
      headers: {
        "User-Agent": "Prayerbox Daily Readings/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`USCCB feed request failed with status ${response.status}.`);
    }

    const xml = await response.text();
    const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
    if (!itemMatch) {
      throw new Error("No reading item found in the USCCB feed.");
    }

    const itemXml = itemMatch[1];
    const title = matchTag(itemXml, "title");
    const link = matchTag(itemXml, "link");
    const descriptionEncoded = matchTag(itemXml, "description");
    const pubDate = matchTag(itemXml, "pubDate");

    return json(request, 200, {
      ok: true,
      reading: {
        descriptionEncoded,
        link,
        pubDate,
        source: FEED_URL,
        sourceName: "USCCB Daily Readings RSS",
        title,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
