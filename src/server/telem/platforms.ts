/**
 * Which Telem fetch providers read a platform link — the ids and link forms on
 * https://docs.telem.ai/resources/supported-platforms/. A link that matches is
 * read with that platform's chain pinned (YouTube transcripts, X posts,
 * LinkedIn records, Maps places…); anything else goes down Telem's default
 * chain. `providers: null` names a platform Telem routes well on its own
 * (Reddit posts go to their provider first without a pin).
 */

export type Platform = { name: string; providers: string[] | null };

type Rule = { name: string; host: RegExp; path?: RegExp; providers: string[] | null };

const RULES: Rule[] = [
  { name: "YouTube", host: /(^|\.)youtube\.com$/, path: /^\/(watch|shorts\/|live\/|embed\/)/, providers: ["fetchlayer_youtube", "socialdatax_youtube"] },
  { name: "YouTube", host: /^youtu\.be$/, providers: ["fetchlayer_youtube", "socialdatax_youtube"] },
  { name: "TikTok", host: /(^|\.)tiktok\.com$/, path: /^\/@[^/]+\/video\//, providers: ["fetchlayer_tiktok", "socialdatax_tiktok"] },
  { name: "X", host: /(^|\.)(x|twitter)\.com$/, path: /^\/[^/]+\/status\/\d+/, providers: ["fetchlayer_x", "socialdatax_x"] },
  { name: "Instagram", host: /(^|\.)instagram\.com$/, path: /^\/(p|reel|tv)\//, providers: ["fetchlayer_instagram", "socialdatax_instagram"] },
  { name: "LinkedIn Ads", host: /(^|\.)linkedin\.com$/, path: /^\/ad-library\/detail\//, providers: ["fetchlayer_linkedin_ads"] },
  { name: "LinkedIn", host: /(^|\.)linkedin\.com$/, path: /^\/(company|showcase|jobs\/view|posts|feed\/update)\//, providers: ["brightdata"] },
  { name: "Reddit", host: /(^|\.)reddit\.com$/, providers: null },
  { name: "Google Maps", host: /^maps\.app\.goo\.gl$/, providers: ["fetchlayer_google_maps", "outscraper_gmaps"] },
  { name: "Google Maps", host: /^goo\.gl$/, path: /^\/maps\//, providers: ["fetchlayer_google_maps", "outscraper_gmaps"] },
  { name: "Google Maps", host: /(^|\.)google\.[a-z.]+$/, path: /^\/maps\/place\//, providers: ["fetchlayer_google_maps", "outscraper_gmaps"] },
  { name: "Amazon", host: /(^|\.)amazon\.[a-z.]+$/, path: /\/(dp|gp\/product|gp\/aw\/d)\//, providers: ["fetchlayer_amazon"] },
  { name: "Trustpilot", host: /(^|\.)trustpilot\.com$/, path: /^\/review\//, providers: ["fetchlayer_trustpilot"] },
  { name: "Product Hunt", host: /(^|\.)producthunt\.com$/, path: /^\/(products|posts)\//, providers: ["fetchlayer_producthunt"] },
  { name: "Google Play", host: /^play\.google\.com$/, path: /^\/store\/apps\/details/, providers: ["fetchlayer_playstore"] },
  { name: "App Store", host: /^(apps|itunes)\.apple\.com$/, path: /\/id\d+/, providers: ["fetchlayer_appstore"] },
  { name: "Yelp", host: /(^|\.)yelp\.[a-z.]+$/, path: /^\/biz\//, providers: ["outscraper_yelp"] },
  { name: "TripAdvisor", host: /(^|\.)tripadvisor\.[a-z.]+$/, path: /(Restaurant|Hotel|Attraction)_Review-/, providers: ["outscraper_tripadvisor"] },
  { name: "Booking.com", host: /(^|\.)booking\.com$/, path: /^\/hotel\//, providers: ["fetchlayer_booking"] },
  { name: "Glassdoor", host: /(^|\.)glassdoor\.[a-z.]+$/, path: /-E\d+\.htm/, providers: ["fetchlayer_glassdoor"] },
  { name: "Airbnb", host: /(^|\.)airbnb\.[a-z.]+$/, path: /^\/rooms\//, providers: ["fetchlayer_airbnb"] },
  { name: "Substack", host: /\.substack\.com$/, path: /^\/(p|pub\/[^/]+\/p)\//, providers: ["apify_substack"] },
  { name: "Pinterest", host: /(^|\.)pinterest\.[a-z.]+$/, path: /^\/pin\//, providers: ["apify_pinterest"] },
  { name: "Pinterest", host: /^pin\.it$/, providers: ["apify_pinterest"] },
  { name: "Telegram", host: /^(t|telegram)\.me$/, path: /^\/(s\/)?[^/]+\/\d+/, providers: ["tikhub_telegram"] },
  { name: "Bilibili", host: /(^|\.)bilibili\.com$/, path: /^\/video\//, providers: ["tikhub_bilibili", "socialdatax_bilibili"] },
  { name: "Weibo", host: /(^|\.)weibo\.(com|cn)$/, providers: ["tikhub_weibo", "socialdatax_weibo"] },
  { name: "Zhihu", host: /(^|\.)zhihu\.com$/, providers: ["socialdatax_zhihu", "tikhub_zhihu"] },
  { name: "Twitch", host: /(^|\.)twitch\.tv$/, path: /^\/[^/]+\/?$/, providers: ["apify_twitch"] },
  { name: "G2", host: /(^|\.)g2\.com$/, path: /^\/products\//, providers: ["apify_g2"] },
];

/** the platform a link belongs to, with the fetch chain to pin, or null for the open web */
export function platformOf(rawUrl: string): Platform | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  for (const rule of RULES) {
    if (!rule.host.test(host)) continue;
    if (rule.path && !rule.path.test(url.pathname)) continue;
    return { name: rule.name, providers: rule.providers };
  }
  return null;
}
