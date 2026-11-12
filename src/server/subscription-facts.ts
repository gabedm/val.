/** Separately dated UK research. The original catalogue and execution integrations stay intact. */
export const subscriptionFactsVersion = "uk-subscription-facts.2";
export const subscriptionFacts: Record<
  string,
  {
    checkedOn: string;
    market: string;
    currency: string;
    plan: string;
    monthlyMinor: number;
    billingUnit?: "30_days";
    facts: string[];
    sources: string[];
  }
> = {
  disney: {
    checkedOn: "2026-10-16",
    market: "GB",
    currency: "GBP",
    plan: "Standard",
    monthlyMinor: 1199,
    facts: [
      "Standard: ad-free movies and series, up to 1080p, two concurrent streams, downloads on up to ten devices.",
      "Grey’s Anatomy is listed on the UK Disney+ title page; confirm the particular season and episode before changing services.",
      "Standard with Ads is separately advertised at £6.99/month, without downloads. Do not assume the user accepts ads.",
      "Prices used here are rolling monthly prices, excluding trials and six-month saver commitments.",
    ],
    sources: [
      "https://www.disneyplus.com/en-gb",
      "https://www.disneyplus.com/en-gb/browse/entity-bfd6ba83-5fff-46f8-abae-76f1796c1c8e",
    ],
  },
  "apple-music": {
    checkedOn: "2026-10-16",
    market: "GB",
    currency: "GBP",
    plan: "Individual",
    monthlyMinor: 1199,
    facts: [
      "One person; ad-free on-demand music, offline downloads, lossless audio. Works on iOS and Android.",
      "Not evidence of equivalent Spotify audiobooks, podcasts, social features, playlists or a particular artist's availability. Ask when these matter.",
      "Regular monthly price; no trial or student eligibility assumed.",
    ],
    sources: ["https://www.apple.com/uk/apple-music/"],
  },
  voxi: {
    checkedOn: "2026-10-16",
    market: "GB",
    currency: "GBP",
    plan: "20GB + Unlimited Social Media",
    monthlyMinor: 1000,
    billingUnit: "30_days",
    facts: [
      "£10 per rolling 30-day period; 20GB general data plus unlimited selected social apps in the UK. Unlimited UK calls and texts; 5G and eSIM available.",
      "Selected social apps: Snapchat, Instagram, WhatsApp, Facebook, Twitter, Pinterest, Facebook Messenger. Excludes third-party ads, external sites and voice/video calls. TikTok and YouTube are not included in this social-only plan.",
      "Check which social apps the person uses and how much data they use outside them. Do not claim it replaces 120GB for every user.",
      "Check location coverage, roaming and current contract end/exit fees. No coverage or zero exit fees have been established.",
      "Conservative 365-day budget: thirteen £10 renewals including the initial payment, £130 before overlap and any old-provider exit fee. No introductory discount assumed.",
    ],
    sources: ["https://www.voxi.co.uk/sim-only-plans", "https://www.voxi.co.uk/move/plans"],
  },
};
