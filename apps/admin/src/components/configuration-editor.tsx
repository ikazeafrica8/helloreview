'use client'

import { useId, useState } from 'react'
import {
  evaluateConsoleEditorDraft,
  type ConsoleEditor,
  type ConsoleEditorField,
  type ConsoleEditorPreviewResult,
} from '@/lib/console-contract'

function EditorField({ field, id }: Readonly<{ field: ConsoleEditorField; id: string }>) {
  const common = {
    id,
    name: field.name,
    defaultValue: field.defaultValue,
    required: field.required,
  }
  if (field.kind === 'textarea')
    return (
      <textarea
        {...common}
        minLength={field.minLength ?? undefined}
        maxLength={field.maxLength ?? undefined}
        rows={5}
      />
    )
  if (field.kind === 'select')
    return (
      <select {...common}>
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  return (
    <input
      {...common}
      type={field.kind}
      minLength={field.kind === 'text' ? (field.minLength ?? undefined) : undefined}
      maxLength={field.kind === 'text' ? (field.maxLength ?? undefined) : undefined}
      min={field.kind === 'number' ? (field.minimum ?? undefined) : undefined}
      max={field.kind === 'number' ? (field.maximum ?? undefined) : undefined}
      autoComplete="off"
    />
  )
}

export function ConfigurationEditor({ editor }: Readonly<{ editor: ConsoleEditor }>) {
  const baseId = useId()
  const [result, setResult] = useState<ConsoleEditorPreviewResult | null>(null)

  return (
    <section className="configuration-editor" aria-labelledby={`${baseId}-title`}>
      <div className="editor-heading">
        <div>
          <p className="eyebrow">DETERMINISTIC NO-WRITE EDITOR</p>
          <h2 id={`${baseId}-title`}>{editor.title}</h2>
          <p>{editor.description}</p>
        </div>
        <dl>
          <div>
            <dt>스키마</dt>
            <dd>{editor.schemaVersion}</dd>
          </div>
          <div>
            <dt>기준 버전</dt>
            <dd>v{editor.currentVersion}</dd>
          </div>
          <div>
            <dt>수명주기</dt>
            <dd>{editor.lifecycleState}</dd>
          </div>
          <div>
            <dt>Maker-checker</dt>
            <dd>{editor.makerCheckerState}</dd>
          </div>
        </dl>
      </div>
      <form
        className="editor-form"
        onChange={() => setResult(null)}
        onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const values = Object.fromEntries(
            editor.fields.map((field) => {
              const value = formData.get(field.name)
              return [field.name, typeof value === 'string' ? value : '']
            }),
          )
          setResult(evaluateConsoleEditorDraft(editor, values))
        }}
      >
        <div className="editor-field-grid">
          {editor.fields.map((field) => {
            const id = `${baseId}-${field.name}`
            return (
              <label key={field.name} htmlFor={id}>
                {field.label}
                {field.required ? <span aria-hidden="true"> *</span> : null}
                <EditorField field={field} id={id} />
              </label>
            )
          })}
        </div>
        <p className="action-warning">
          검증 결과만 브라우저에 표시하며 데이터베이스, 메시지 제공자, 게시 버전을 변경하지 않습니다.
        </p>
        <button type="submit">fixture 초안 검증</button>
      </form>
      {result === null ? null : (
        <div
          className={`editor-result ${result.valid ? 'result-safe' : 'result-blocked'}`}
          role="status"
          aria-live="polite"
        >
          <strong>{result.reasonCode}</strong>
          <p>{result.message}</p>
          {result.issueCodes.length === 0 ? null : (
            <ul>
              {result.issueCodes.map((issueCode) => (
                <li key={issueCode}>{issueCode}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
