# Manual website application import — pilot runbook

This is the pilot fallback when the outsourced website provides neither an API nor database access.
It imports a complete CSV export into HelloReview without storing the source file in the database.
The website remains the source of truth.

## Before each import

1. Export **all applications in scope**, not only rows believed to be new. Record the time at which
   the export finished; that is `--exported-at`.
2. Work on a private operator machine. Do not email the XLSX/CSV, commit it, or place it in a shared
   folder. These files contain personal data.
3. Validate the website XLSX against the [verified export mapping](./website-application-export-mapping.md).
4. Confirm every website `캠페인번호` maps to an existing HelloReview campaign code. Unknown
   campaigns reject the complete canonical file before any row is synchronized.

The required columns are:

| Column                | Rule                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `application_id`      | Stable website application identifier; required and unique within the file    |
| `campaign_code`       | Existing HelloReview campaign code                                            |
| `application_status`  | `received`, `completed`, `matched`, `ambiguous`, or `cancelled`               |
| `applicant_name`      | Required                                                                      |
| `phone_normalized`    | E.164, for example `+821012345678`                                            |
| `blog_url`            | Blank or an `http`/`https` URL                                                |
| `blogger_level`       | Positive integer from `회원레벨`; this is a blogger rank, not workflow status |
| `blog_daily_visitors` | Nonnegative integer from `블로그일평균방문자수`                               |
| `blogger_region`      | Blank or a coarse `지역` value; never copy a detailed address                 |
| `submitted_at`        | ISO 8601 timestamp with timezone                                              |
| `updated_at`          | ISO 8601 timestamp with timezone; not earlier than `submitted_at`             |

## Convert the website XLSX

Validate without writing a PII-bearing CSV:

```powershell
pnpm applications:convert-xlsx -- --file .\private\application-imports\website-export.xlsx --validate-only --exported-at 2026-08-24T14:02:48+09:00
```

Then convert it. Supply `--campaign-map` when local campaign codes differ from website campaign
numbers:

```powershell
pnpm applications:convert-xlsx -- --file .\private\application-imports\website-export.xlsx --output .\private\application-imports\applications.csv --campaign-map .\private\application-imports\campaign-map.json --exported-at 2026-08-24T14:02:48+09:00
```

Conversion is strict by default. `--allow-missing-phone` is a visible, controlled pilot exception:
it excludes phone-less applications and prints only their spreadsheet row numbers. Do not use it
silently or assume those applications were imported.

## Run the import

The normal HelloReview deployment must first apply migrations through
`0015_add_application_blogger_ranking`.
The CSV operator uses the restricted application `DATABASE_URL` and should not receive migration or
outsourced-website database credentials.

From the repository root, with `DATABASE_URL` and `MASKING_PEPPER` present in `.env`:

```powershell
pnpm applications:import-csv -- --file .\private\application-imports\applications.csv --exported-at 2026-08-24T10:30:00+09:00
```

The command prints only the batch id and row counts. It does not print applicant values or the file
path. A successful run records a keyed file digest and counts, but never stores the CSV itself.

## Safety and retry behavior

- Parsing and campaign validation finish before application writes begin.
- Re-running the same file with the same export time is a safe replay and returns the original batch.
- A newer row gets the next local source version. A row whose `updated_at` is older than the current
  projection is counted as stale and cannot roll state backward.
- If a process or database failure interrupts a batch, rerun the same command. Row event identities
  are deterministic, so completed rows are duplicates and remaining rows continue safely.
- Freshness is based on `--exported-at`, not the later upload time. Uploading an old export therefore
  does not make the website data look current.
- After a successful import, securely delete the working CSV according to the organization's data
  retention policy.

Do not expose this importer as a public upload route. A later authenticated admin screen or browser
automation can call the same service after operator authorization, file scanning, and audit controls
are in place.
