import { Actor, log } from "apify";
import { gotScraping } from "got-scraping";

await Actor.main(async () => {
    const input = await Actor.getInput();
    const { cookie, userAgent, urls, limitPerSource = 20, minDelay = 2, maxDelay = 4, scrapeUntilDate, proxy } = input;
    
    if (!cookie || cookie.length === 0) {
        log.error("Cookies missing! Paste JSON from Cookie-Editor. Need li_at and JSESSIONID");
        return;
    }
    log.info(`Cookies loaded: ${cookie.length}, URLs: ${urls.length}`);
    
    const proxyConfiguration = await Actor.createProxyConfiguration(proxy);
    const cookieStr = cookie.map(c => `${c.name}=${c.value}`).join("; ");
    const csrfToken = cookie.find(c => c.name === "JSESSIONID")?.value?.replace(/"/g, "") || "";
    const untilTs = scrapeUntilDate ? new Date(scrapeUntilDate).getTime() : 0;
    
    const headers = {
        "User-Agent": userAgent,
        "Cookie": cookieStr,
        "Csrf-Token": `ajax:${csrfToken}`,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "accept": "application/vnd.linkedin.normalized+json+2.1"
    };
    
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    
    for (const sourceUrl of urls) {
        log.info(`Scraping: ${sourceUrl}`);
        let start = 0;
        let count = 0;
        let hasMore = true;
        
        while (hasMore && count < limitPerSource) {
            let apiUrl = "";
            if (sourceUrl.includes("/search/results/content")) {
                const u = new URL(sourceUrl);
                // Use full query passthrough - most reliable
                apiUrl = `https://www.linkedin.com/voyager/api/search/hits?blendedSearchSegment=CONTENT&count=10&start=${start}&q=blended&query=${encodeURIComponent(u.search)}`;
                // Fallback simple: keywords only if above fails
                if (!u.searchParams.get("keywords")) {
                    apiUrl = `https://www.linkedin.com/voyager/api/search/hits?blendedSearchSegment=CONTENT&count=10&start=${start}&q=blended&query=(keywords:data%20analyst)`;
                }
            } else if (sourceUrl.includes("/feed/update/")) {
                const urn = sourceUrl.match(/urn:li:activity:\d+/)?.[0];
                if (!urn) break;
                apiUrl = `https://www.linkedin.com/voyager/api/feed/updates/${urn}`;
                hasMore = false;
            } else {
                apiUrl = `https://www.linkedin.com/voyager/api/feed/updates?count=10&start=${start}&q=chronFeed`;
            }

            const proxyUrl = await proxyConfiguration.newUrl();
            log.info(`Fetching start=${start} -> ${apiUrl.substring(0,120)}... via proxy ${proxyUrl ? "yes" : "no"}`);

            try {
                const response = await gotScraping({
                    url: apiUrl,
                    headers,
                    proxyUrl,
                    responseType: "json",
                    throwHttpErrors: false,
                    timeout: { request: 30000 },
                    retry: { limit: 1 }
                });
                
                log.info(`Response: ${response.statusCode}`);

                if (response.statusCode === 999 || response.statusCode === 401 || response.statusCode === 403) {
                    log.error(`Auth failed ${response.statusCode}. Your li_at cookie expired or proxy country mismatch. Re-export cookies and use RESIDENTIAL proxy in same country as login.`);
                    hasMore = false;
                    break;
                }
                if (response.statusCode !== 200) {
                    log.error(`API Error ${response.statusCode}: ${JSON.stringify(response.body).substring(0,500)}`);
                    hasMore = false;
                    break;
                }

                const body = response.body;
                const elements = body.elements || body.included || [];
                const posts = elements.filter(x => x.urn?.includes("activity") || x.entityUrn?.includes("activity"));
                
                log.info(`Got ${posts.length} posts at start ${start}`);
                if (posts.length === 0) {
                    log.info(`No more posts. Full body keys: ${Object.keys(body)}`);
                    hasMore = false;
                    break;
                }
                
                for (const item of posts) {
                    const post = {
                        urn: item.urn || item.entityUrn,
                        text: item.commentary?.text?.text || item.text?.text || "",
                        url: `https://www.linkedin.com/feed/update/${item.urn || item.entityUrn}`,
                        postedAtTimestamp: item.createdAt || Date.now(),
                        postedAtISO: new Date(item.createdAt || Date.now()).toISOString()
                    };
                    if (untilTs && post.postedAtTimestamp < untilTs) { hasMore = false; break; }
                    await Actor.pushData(post);
                    count++;
                    if (count >= limitPerSource) { hasMore = false; break; }
                }
                if (posts.length < 10) hasMore = false;
            } catch (e) {
                log.error(`Request failed: ${e.message}`);
                hasMore = false;
            }
            start += 10;
            if (hasMore) await sleep((Math.random() * (maxDelay - minDelay) + minDelay) * 1000);
        }
        log.info(`Done source. Total pushed: ${count}`);
    }
});
