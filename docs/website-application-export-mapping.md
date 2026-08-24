# HelloReview website application XLSX mapping

This document is the non-PII schema reference for the outsourced website export named
`신청목록 HelloReview.xlsx`. It is safe to keep in source control: no applicant row values are
included.

## Verified reference workbook

- Observed: 2026-08-24
- SHA-256: `2971d97b88e65d8ae81fab69ab295aaa1dedb918bbc33e8e1d820194242df582`
- Shape: one visible sheet named `Worksheet`, range `A1:AG4301`
- Records: 4,300 data rows and 33 columns
- Formulas, tables, filters and merged cells: none
- Application ids (`고유번호`): 4,300 nonblank and 4,300 unique
- Website campaign numbers (`캠페인번호`): 136 unique
- Application period: 2024-02-23 through 2026-08-24

The schema is enforced exactly by `tools/lib/helloreview-website-export.mjs`. A renamed, reordered,
missing or additional header rejects the workbook before conversion.

## Canonical application mapping

| Canonical field       | Website column              | Rule                                                                                                  |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `application_id`      | `고유번호`                  | Required decimal identifier; the stable upstream application key                                      |
| `campaign_code`       | `캠페인번호`                | Stable external campaign key; resolve through an explicit campaign map when local codes differ        |
| `application_status`  | long `진행상태(...)` column | Only observed and approved code `1` maps to `received`; codes `2–7` reject pending a product decision |
| `applicant_name`      | `이름`                      | Required; shipping-recipient name is deliberately ignored                                             |
| `phone_normalized`    | `휴대폰`                    | Korean `010` forms normalize to E.164 `+8210...`                                                      |
| `blog_url`            | `채널`                      | Retained only for `http`/`https`; blank or non-URL values become blank                                |
| `blogger_level`       | `회원레벨`                  | Required positive integer; source-owned blogger rank, not application lifecycle status                |
| `blog_daily_visitors` | `블로그일평균방문자수`      | Required nonnegative integer; retained under the metric name stated by the source header              |
| `blogger_region`      | `지역`                      | Optional coarse category, retained only to support a future campaign-region eligibility rule          |
| `submitted_at`        | `리뷰신청일시`              | Website text is interpreted as Asia/Seoul local time and emitted as ISO 8601                          |
| `updated_at`          | no source column            | Uses the operator-supplied export completion time                                                     |

The source has no last-updated timestamp. Consequently, the converter uses export completion time
for ordering, while application event identity excludes that timestamp. An unchanged row in a later
export is therefore a duplicate, but a changed row is newer; an older export cannot roll it back.

## Data-quality and semantics findings

- All 4,300 rows in the reference file have source status `1`. No mapping for codes `2–7` is claimed
  from this evidence.
- Three rows have no phone. Strict conversion stops on the first. `--allow-missing-phone` can exclude
  rows 2840, 2841 and 2888 for a specifically approved pilot exception; validation then produces
  4,297 eligible rows. This exception must remain visible in the command result.
- Campaign names are display labels, not keys. There are 10 campaign numbers associated with more
  than one name and 13 names associated with more than one campaign number.
- `캠페인 형태(1배송형/2방문형)` contains codes `1`, `2`, `3` and `4`, despite its two-code header.
  The application converter does not use this field. Codes `3` and `4` must not be interpreted
  without separate authoritative documentation.
- The reference export contains channel categories `blog`, `instagram`, `instagram_reels` and
  `shop`. The application mapping uses the actual `채널` URL, not the category label.
- `회원레벨` contains level `1` for 4,297 rows, level `5` for two rows and level `6` for one row.
  Levels `2`, `3` and `4` do not occur in this reference file.
- Within the 4,297 level-1 rows, `블로그일평균방문자수` is `0–300` for 2,542 rows, `301–499` for
  545, `500–999` for 597 and `1,000+` for 613. The export therefore does not establish that level
  1 necessarily means more than 1,000 visitors. The three level-5/6 rows are also too small a sample
  for deriving a traffic threshold.

## Blogger selection policy — user-provided, not inferred

The ranking fields above are source evidence. They are deliberately separate from
`application_status`, which continues to represent the application lifecycle.

- Levels 1–3 should generally be prioritized, with levels 1 and 2 most often selected.
- A regional blogger may remain eligible around 300 visitors when the applicable campaign-region
  rule says the blogger is local.
- The user described visitor thresholds using previous-day visitors, while the source column is
  labelled average daily blog visitors. The importer therefore stores the source-accurate
  `blog_daily_visitors` value and does not silently relabel it as previous-day traffic.

These preferences are not an automatic rejection or scoring rule yet. Automation needs two explicit
decisions: which campaign location must match `blogger_region`, and whether the visitor threshold is
based on previous-day traffic or the exported average-daily value.

## Deliberately discarded columns

The converter does not carry shipping name, postal code, address, shipping phone, application
comment, login id, nickname, email, blacklist flag, device, gender, age, detailed address,
campaign name or answer fields into the canonical file. Detailed location and unrelated profile
data remain excluded to avoid unnecessarily widening the PII footprint.

## Campaign map

If HelloReview campaign codes are not the website's numeric campaign numbers, provide a JSON object
whose keys are `캠페인번호` values and whose values are existing local `campaigns.code` values. When
a map is supplied, every workbook campaign number must be present; there is no partial fallback.

See [`templates/website-campaign-map.example.json`](./templates/website-campaign-map.example.json).
