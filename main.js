import { Actor } from \'apify\';
import { gotScraping } from \'got-scraping\';

await Actor.main(async () => {
    const input = await Actor.getInput();
    const { cookie, userAgent, urls, limitPerSource = 100, deepScrape = true, rawData = false, minDelay = 2, maxDelay = 4, scrapeUntilDate, proxy } = input;
    const proxyConfiguration = await Actor.createProxyConfiguration(proxy);
    const cookieStr = cookie.map(c => `${c.name}=${c.value}`).join(\'; \');
    const csrfToken = cookie.find(c => c.name === \'JSESSIONID\')?.value.replace(/"/g, \'\') || cookie.find(c => c.name === \'JSESSIONID\')?.value || \'\';
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
        let start = 0, count = 0, hasMore = true;
        
        while(hasMore && count < limitPerSource){
            let apiUrl = \'\';
            if(sourceUrl.includes(\'/search/results/content\')){
                const u = new URL(sourceUrl);
                // Voyager search hits endpoint - this is what the original actor uses
                const keywords = u.searchParams.get(\'keywords\') || \'\';
                const query = `(keywords:${keywords})`;
                apiUrl = `https://www.linkedin.com/voyager/api/search/hits?blendedSearchSegment=CONTENT&count=10&start=${start}&q=blended&query=${encodeURIComponent(query)}`;
            } else if(sourceUrl.includes(\'/feed/update/\')){
                const urn = sourceUrl.match(/urn:li:activity:\d+/)?.[0];
                if(!urn) break;
                apiUrl = `https://www.linkedin.com/voyager/api/feed/updates/${urn}`;
                hasMore = false;
            } else if(sourceUrl.includes(\'/in/\') || sourceUrl.includes(\'/company/\')){
                // Profile/Company feed
                apiUrl = `https://www.linkedin.com/voyager/api/feed/updates?count=10&start=${start}&q=chronFeed`;
            }

            const proxyUrl = await proxyConfiguration.newUrl();
            try{
                const { body } = await gotScraping({ url: apiUrl, headers, proxyUrl, responseType: \'json\', retry: {limit: 2} });
                if(rawData){ await Actor.pushData(body); break; }

                const posts = normalizeVoyager(body);
                if(posts.length === 0) hasMore = false;

                for(const post of posts){
                    if(untilTs && post.postedAtTimestamp < untilTs){ hasMore = false; break; }
                    if(deepScrape && post.urn){
                        post.comments = await fetchComments(post.urn, headers, proxyUrl);
                        post.reactions = await fetchReactions(post.urn, headers, proxyUrl);
                    }
                    await Actor.pushData(post);
                    count++;
                    if(count >= limitPerSource){ hasMore = false; break; }
                }
                if(posts.length < 10) hasMore = false;
            } catch(e){
                Actor.log.error(`API Error ${e.response?.statusCode}: ${e.message}`);
                if(e.response?.statusCode === 429) await sleep(30000);
                else hasMore = false;
            }
            start += 10;
            await sleep((Math.random()*(maxDelay-minDelay)+minDelay)*1000);
        }
    }
});

function normalizeVoyager(body){
    // Handles both search/hits and feed/updates structures
    const elements = body.elements || body.included || [];
    const included = body.included || [];
    const all = [...elements, ...included];
    return all.filter(x => x.urn?.includes(\'activity\') || x.entityUrn?.includes(\'activity\')).map(item => {
        const urn = item.urn || item.entityUrn || item.trackingUrn;
        return {
            urn: urn,
            text: item.commentary?.text?.text || item.text?.text || "",
            url: `https://www.linkedin.com/feed/update/${urn}`,
            postedAtTimestamp: item.createdAt || item.publishedAt || Date.now(),
            postedAtISO: new Date(item.createdAt || Date.now()).toISOString(),
            author: item.actor || item.author || {},
            authorProfileUrl: item.actor?.navigationUrl || "",
            numLikes: item.socialDetail?.totalSocialActivityCounts?.numLikes || 0,
            numComments: item.socialDetail?.totalSocialActivityCounts?.numComments || 0,
            numShares: item.socialDetail?.totalSocialActivityCounts?.numShares || 0,
            images: item.content?.images?.map(i=>i.vectorImage?.rootUrl) || [],
            raw: item
        }
    });
}
async function fetchComments(urn, headers, proxyUrl){
    try{ const {body}=await gotScraping({url:`https://www.linkedin.com/voyager/api/feed/comments?urn=${urn}&count=10`, headers, proxyUrl, responseType:\'json\'}); return body.elements||[] }catch{ return [] }
}
async function fetchReactions(urn, headers, proxyUrl){
    try{ const {body}=await gotScraping({url:`https://www.linkedin.com/voyager/api/feed/reactions?urn=${urn}&count=10`, headers, proxyUrl, responseType:\'json\'}); return body.elements||[] }catch{ return [] }
}
