import {
  BASE_URL, CLIError, decodeEntities, finnishDate, helsinkiToday, htmlToText, inlineText, kuntarekryGet,
  normalizeJobRef, stripInvisible, visibleHtml, type Format,
} from "../helpers.js"

export interface JobDetail {
  id: string
  title: string
  company: string | null
  unit: string | null
  location: string | null
  region: string | null
  date: string | null
  deadline: string | null
  deadlineTime: string | null
  isActive: boolean | null
  employmentType: string | null
  contractType: string | null
  start: string | null
  salary: string | null
  jobKey: string | null
  description: string | null
  applyUrl: string | null
  url: string
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))
  return m ? decodeEntities(m[1] ?? m[2] ?? "").trim() || null : null
}

/** The page's schema.org JobPosting, if it carries one. */
function jobPosting(html: string): Record<string, unknown> | null {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1])
      if (data && typeof data === "object" && data["@type"] === "JobPosting") return data as Record<string, unknown>
    } catch {
      // A malformed block is skipped; the visible page is parsed below anyway.
    }
  }
  return null
}

/** `<ip-details title="...">...</ip-details>` sections, in page order. */
function sections(html: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = []
  for (const m of html.matchAll(/<ip-details\b([^>]*)>([\s\S]*?)<\/ip-details>/gi)) {
    out.push({ title: attr(m[1], "title") ?? "", body: m[2] })
  }
  return out
}

/** The "Työpaikan tiedot" aside: label -> lines of its value (the employer is "City\nUnit"). */
function facts(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const m of body.matchAll(/<ip-aside-item\b([^>]*)>([\s\S]*?)<\/ip-aside-item>/gi)) {
    const label = attr(m[1], "title")
    const lines = htmlToText(m[2]).split("\n").map((l) => l.trim()).filter(Boolean)
    if (label && lines.length) out[label] = lines
  }
  return out
}

function text(value: unknown): string | null {
  return typeof value === "string" ? inlineText(value) : null
}

export function parseDetail(html: string, slug: string, today = helsinkiToday()): JobDetail {
  // JSON-LD is read from the raw page (it lives in a <script>); everything a
  // reader sees is read from the page with hidden markup already removed.
  const ld = jobPosting(html) ?? {}
  const visible = visibleHtml(html)
  const view = visible.match(/<job-view\b[^>]*>/i)?.[0] ?? ""
  const all = sections(visible)
  const factSection = all.find((s) => s.title === "Työpaikan tiedot" || s.title === "Arbetsplatsens uppgifter" || s.title === "Job details")
  const info = factSection ? facts(factSection.body) : {}
  const one = (label: string): string | null => info[label]?.join(" ") ?? null

  const title = attr(view, "job-title") ?? text(ld.title)
  if (!title) throw new CLIError("Kuntarekry returned a page without a job title", "BAD_RESPONSE")

  // "Työnantaja" holds the employer on its first line and the unit below it.
  const org = ld.hiringOrganization
  const ldCompany = typeof org === "string" ? text(org) : org && typeof org === "object" ? text((org as Record<string, unknown>).name) : null
  const employerLines = info["Työnantaja"] ?? []
  const company = employerLines[0] ?? ldCompany
  // The unit line often repeats the employer ("Suomen Kuntaliitto, Asiakkuudet ..."); drop that prefix.
  const unitRaw = employerLines.slice(1).join(", ")
  const unit = (company && unitRaw.startsWith(`${company}, `) ? unitRaw.slice(company.length + 2) : unitRaw) || null

  const address = (ld.jobLocation as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined
  const location = text(address?.addressLocality)
  const region = text(address?.addressRegion)

  // "23.11.2026 klo 11:21 - 6.1.2027 klo 23:59"
  const period = one("Hakuaika")?.match(/^(\d{1,2}\.\d{1,2}\.\d{4})(?:\s+klo\s+[\d:.]+)?\s*-\s*(\d{1,2}\.\d{1,2}\.\d{4})(?:\s+klo\s+([\d:.]+))?/)
  const posted = typeof ld.datePosted === "string" && /^\d{4}-\d{2}-\d{2}/.test(ld.datePosted) ? ld.datePosted.slice(0, 10) : finnishDate(period?.[1])
  const deadline = finnishDate(period?.[2])

  const salaryLd = (ld.baseSalary as Record<string, unknown> | undefined)?.value
  const salary = one("Palkka") ?? (typeof salaryLd === "string" ? text(salaryLd) : null)

  // The posting itself: the lead paragraph plus every titled section except the fact table.
  const lead = visible.match(/<p class="lead"[^>]*>([\s\S]*?)<\/p>/i)?.[1]
  const parts = [lead ? htmlToText(lead) : ""]
  for (const s of all) {
    if (s === factSection) continue
    const body = htmlToText(s.body)
    if (body) parts.push(s.title ? `${s.title}\n${body}` : body)
  }
  const description = parts.filter(Boolean).join("\n\n") || null

  const applyTag = visible.match(/<a\b[^>]*class="[^"]*\bapply-button\b[^"]*"[^>]*>/i)?.[0]
  const applyHref = applyTag ? attr(applyTag, "href") : null
  let applyUrl: string | null = null
  if (applyHref) {
    try {
      const u = new URL(applyHref, BASE_URL)
      if (u.protocol === "https:" || u.protocol === "http:") applyUrl = u.href
    } catch {
      applyUrl = null
    }
  }

  return stripInvisible({
    id: slug,
    title,
    company,
    unit,
    location,
    region,
    date: posted,
    deadline,
    deadlineTime: period?.[3] ?? null,
    isActive: deadline ? deadline >= today : null,
    employmentType: one("Tyyppi"),
    contractType: one("Työsuhteen tyyppi"),
    start: one("Työn alkamispäivä/ajankohta"),
    salary,
    jobKey: one("Työavain") ?? attr(view, "job-ext-id"),
    description,
    applyUrl,
    url: `${BASE_URL}/fi/tyopaikat/${slug}/`,
  })
}

export async function detail(input: string, get: (path: string) => Promise<string | null> = (p) => kuntarekryGet(p, "html")) {
  const slug = normalizeJobRef(input)
  if (!slug) throw new CLIError("Expected a Kuntarekry job id (the URL slug) or a kuntarekry.fi/fi/tyopaikat/<slug>/ URL", "BAD_ID")
  const html = await get(`/fi/tyopaikat/${slug}/`)
  if (html === null) throw new CLIError("Job not found (it may have closed)", "NOT_FOUND")
  return parseDetail(html, slug)
}

export async function runDetail(input: string, format: Format): Promise<void> {
  const job = await detail(input)
  const out = format === "json" ? JSON.stringify(job, null, 2) : [
    job.title,
    `${job.company ?? "—"}${job.unit ? ` (${job.unit})` : ""} · ${job.location ?? "—"}${job.region && job.region !== job.location ? `, ${job.region}` : ""}`,
    `Posted: ${job.date ?? "unknown"} · Apply by: ${job.deadline ?? "unknown"}${job.deadlineTime ? ` ${job.deadlineTime}` : ""}${job.isActive === false ? " (closed)" : ""}`,
    `Type: ${[job.employmentType, job.contractType].filter(Boolean).join(", ") || "unknown"} · Start: ${job.start ?? "unknown"}`,
    `Salary: ${job.salary ?? "unknown"} · Job key: ${job.jobKey ?? "unknown"}`,
    "",
    job.description ?? "(no description)",
    "",
    `URL: ${job.url}`,
    `Apply: ${job.applyUrl ?? job.url}`,
  ].join("\n")
  process.stdout.write(out + "\n")
}
