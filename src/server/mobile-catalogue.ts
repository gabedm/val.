import type { CatalogueResponse } from "../shared/contracts.types";

/** New read-only mobile entries, separate from the preserved 200-service research baseline. */
export function withMobileServices(base: CatalogueResponse["catalogue"]): CatalogueResponse["catalogue"] {
  const common = {
    category: "mobile",
    comparison_group: "uk_sim_only",
    audience: "consumer_or_individual_prosumer",
    research_flags: [],
    evidence: [],
    execution: {
      integration_status: "catalogue_only",
      purchase_supported: false,
      cancellation_supported: false,
      migration_supported: false,
    },
  };
  const mobile: CatalogueResponse["catalogue"]["services"] = [
    {
      ...common,
      id: "three",
      service: "Three",
      plan: "SIM-only",
      purpose: "Mobile data, calls and texts",
      capability_tags: ["mobile_data", "uk_calls_and_texts"],
      constraints: [
        "Use your own bill for your tariff, data allowance, minimum term and any early exit charge.",
        "Coverage, roaming and scheduled price increases depend on your plan.",
      ],
      price: {
        amount: 0,
        currency: "GBP",
        unit: "month",
        kind: "unknown",
        market_country: "GB",
        charge_basis: "per_selected_plan",
        minimum_seats: 1,
        commitment_months: null,
      },
      sources: [
        {
          url: "https://www.three.co.uk/sim-only",
          checked_on: "2026-10-16",
          pricing_channel: "provider_service_page_not_a_price_quote",
        },
      ],
    },
    {
      ...common,
      id: "voxi",
      service: "VOXI",
      plan: "20GB + Unlimited Social Media",
      purpose: "Mobile data with unlimited use of selected social apps in the UK",
      capability_tags: [
        "20GB_general_data",
        "selected_unlimited_social_apps",
        "unlimited_uk_calls_and_texts",
        "5g",
        "rolling_30_day_plan",
      ],
      constraints: [
        "Unlimited social applies to selected apps in the UK, excluding third-party ads, external sites and voice/video calls.",
        "TikTok and YouTube are not included in the £10 social-only plan.",
        "Check coverage, roaming, remaining Three commitment and any exit fee before changing.",
        "Renews every 30 days; a 365-day budget includes 13 payments (£130), before overlap or exit fees.",
      ],
      price: {
        amount: 10,
        currency: "GBP",
        unit: "30_days",
        billing_interval: "30_days",
        kind: "published",
        market_country: "GB",
        charge_basis: "per_selected_plan",
        minimum_seats: 1,
        commitment_months: null,
      },
      sources: [
        {
          url: "https://www.voxi.co.uk/sim-only-plans",
          checked_on: "2026-10-16",
          pricing_channel: "provider_published_offer",
        },
        {
          url: "https://www.voxi.co.uk/move/plans",
          checked_on: "2026-10-16",
          pricing_channel: "provider_plan_features",
        },
      ],
    },
  ];
  return {
    ...base,
    categories: [...base.categories, { id: "mobile", label: "Mobile plans", count: mobile.length }],
    services: [...base.services, ...mobile],
  };
}
