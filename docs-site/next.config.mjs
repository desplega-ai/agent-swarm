import { createMDX } from "fumadocs-mdx/next";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withMDX = createMDX();

const legacyIntegrationRedirects = [
  ["linear-integration", "linear"],
  ["slack-integration", "slack"],
  ["github-integration", "github"],
  ["gitlab-integration", "gitlab"],
  ["agentmail-integration", "agentmail"],
  ["sentry-integration", "sentry"],
  ["jira-integration", "jira"],
].flatMap(([oldSlug, newSlug]) =>
  ["", ".md", ".mdx"].map((extension) => ({
    source: `/docs/guides/${oldSlug}${extension}`,
    destination: `/docs/integrations/${newSlug}${extension}`,
    statusCode: 301,
  })),
);

// Use-case guides written by the Omnia insights loop moved from /docs/guides to
// /docs/playbooks/use-cases. These URLs are cited externally, so keep them 301.
const movedUseCaseGuides = [
  "agent-assisted-bank-reconciliation-review",
  "ai-delivery-delay-handoff",
  "ai-demand-forecast-accuracy-review",
  "ai-inventory-exception-handoff",
  "ai-invoice-discrepancy-review",
  "ai-operations-governance",
  "ai-operations-shift-handoff",
  "ai-payroll-discrepancy-review",
  "ai-returns-exception-handoff",
  "ai-rfp-bid-qualification",
  "ai-service-capacity-planning",
  "ai-support-escalation-handoff",
  "ai-training-completion-evidence-review",
  "ai-win-loss-review",
  "business-continuity-tabletop-preparation",
  "choosing-an-ai-operating-model",
  "competitor-change-brief",
  "contractor-license-expiry-review",
  "customer-billing-dispute-review",
  "customer-commitment-tracking",
  "customer-pricing-change-review",
  "customer-renewal-review",
  "digital-content-license-rights-review",
  "employee-offboarding-access-review",
  "employee-onboarding-readiness-review",
  "food-batch-traceability-exercise",
  "food-supplier-ingredient-change-review",
  "guest-accessibility-request-handoff",
  "maintenance-work-order-triage",
  "marketing-campaign-launch-review",
  "marketplace-catalog-discrepancy-review",
  "marketplace-fraud-alert-investigation",
  "marketplace-moderation-appeals",
  "marketplace-payout-exception-review",
  "meeting-decision-follow-up",
  "near-miss-investigation-review",
  "partner-data-feed-freshness-review",
  "partner-onboarding-readiness",
  "privacy-data-request-handoff",
  "service-level-breach-review",
  "small-tech-team-operating-model",
  "supplier-order-confirmation-review",
  "supplier-performance-review",
  "supplier-security-evidence-review",
  "support-knowledge-conflict-review",
];

const useCaseGuideRedirects = movedUseCaseGuides.flatMap((slug) =>
  ["", ".md", ".mdx"].map((extension) => ({
    source: `/docs/guides/${slug}${extension}`,
    destination: `/docs/playbooks/use-cases/${slug}${extension}`,
    statusCode: 301,
  })),
);

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return [
      ...legacyIntegrationRedirects,
      ...useCaseGuideRedirects,
      {
        source: "/docs/api-reference/workflowevents",
        destination: "/docs/api-reference/workflows",
        statusCode: 301,
      },
      {
        source: "/docs/api-reference/task-templates",
        destination: "/docs/api-reference/tasks",
        statusCode: 301,
      },
      {
        source: "/docs/api-reference/workflowevents.md",
        destination: "/docs/api-reference/workflows.md",
        statusCode: 301,
      },
      {
        source: "/docs/api-reference/workflowevents.mdx",
        destination: "/docs/api-reference/workflows.mdx",
        statusCode: 301,
      },
      {
        source: "/docs/api-reference/task-templates.md",
        destination: "/docs/api-reference/tasks.md",
        statusCode: 301,
      },
      {
        source: "/docs/api-reference/task-templates.mdx",
        destination: "/docs/api-reference/tasks.mdx",
        statusCode: 301,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/docs/:path*.mdx",
        destination: "/llms.mdx/docs/:path*",
      },
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
  async headers() {
    // acceptmarkdown.com compliance: advertise that /docs/* responses vary on
    // the Accept header so CDNs/caches don't cross-serve HTML vs. markdown.
    // Declared here (not just in proxy.ts) so the header is applied even when
    // Next.js serves a prerendered static HTML response from cache.
    return [
      {
        source: "/docs",
        headers: [{ key: "Vary", value: "Accept" }],
      },
      {
        source: "/docs/:path*",
        headers: [{ key: "Vary", value: "Accept" }],
      },
    ];
  },
};

export default withMDX(config);
