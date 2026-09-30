import { Actor } from \'apify\';
import { gotScraping } from \'got-scraping\';

await Actor.main(async () => {
    const input = await Actor.getInput();
    const { cookie, userAgent, urls, limitPerSource = 20, deepScrape = true, rawData = false, minDelay = 2, maxDelay = 4, scrapeUntilDate, proxy } = input;
    
    const proxyConfiguration = await Actor.createProxyConfiguration(proxy);
    const cookieStr = cookie.map(c => `${c.name}=${c.value}`).join(\'; \');
    const csrfToken = cookie.find(c => c.name === \'JSESSIONID\')?.value?.replace(/"/g, \'\') || \'\';
    const untilTs = scrapeUntilDate ? new Date(scrapeUntilDate).getTime() : 0;
    
    const headers = {
        \'User-Agent\': userAgent,
        \'Cookie\': cookieStr,
        \'Csrf-Token\': `ajax:${csrfToken}`,
        \'x-restli-protocol-version\': \'2.0.0\',
        \'x-li-lang\': \'en_US\',
        \'accept\': \'application/vnd.linkedin.normalized+json+2.1\'
    };
    
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    
    for (const sourceUrl of urls) {
        Actor.log.info(`Scraping: ${sourceUrl}`);
        let start = 0;
        let count = 0;
        let hasMore = true;
        
        while (hasMore && count < limitPerSource) {
            let apiUrl = \'\';
            if (sourceUrl.includes(\'/search/results/content\')) {
                const u = new URL(sourceUrl);
                const kw = u.searchParams.get(\'keywords\') || \'\';
                apiUrl = `https://www.linkedin.com/voyager/api/search/hits?blendedSearchSegment=CONTENT&count=10&start=${start}&q=blended&query=${encodeURIComponent(`(keywords:${kw})`)}`;
            } else if (sourceUrl.includes(\'/feed/update/\')) {
                const urn = sourceUrl.match(/urn:li:activity:\d+/)?.[0];
                if (!urn) break;
                apiUrl = `https://www.linkedin.com/voyager/api/feed/updates/${urn}`;
                hasMore = false;
            } else {
                apiUrl = `https://www.linkedin.com/voyager/api/feed/updates?count=10&start=${start}&q=chronFeed`;
            }

            const proxyUrl = await proxyConfiguration.newUrl();
            try {
                const { body } = await gotScraping({ url: apiUrl, headers, proxyUrl, responseType: \'json\' });
                if (rawData) {
                    await Actor.pushData(body);
                    break;
                }
                const elements = body.elements || body.included || [];
                const posts = elements.filter(x => x.urn?.includes(\'activity\') || x.entityUrn?.includes(\'activity\'));
                
                if (posts.length === 0) hasMore = false;
                
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
                Actor.log.error(`API Error: ${e.message}`);
                hasMore = false;
            }
            start += 10;
            await sleep((Math.random() * (maxDelay - minDelay) + minDelay) * 1000);
        }
    }
});
