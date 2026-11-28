import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

import {
  NotificationTemplate,
  type NotificationTemplateDefinition,
} from "../entities/notification-template.js";

/**
 * Read-only map from template key to {@link NotificationTemplate}, built once at startup from the
 * full set of definitions. There is no `register()`, so the registry can never be half-built when
 * the first notification is sent. Templates ship with the code, so there is no database store (see
 * docs/guides/domain-modeling.md).
 */
export class TemplateRegistry {
  private readonly templates: ReadonlyMap<string, NotificationTemplate>;
  readonly keys: readonly string[];

  private constructor(templates: ReadonlyMap<string, NotificationTemplate>) {
    this.templates = templates;
    this.keys = Object.freeze([...templates.keys()]);
  }

  /**
   * Validates every definition and rejects the whole set if any is invalid or a key repeats. Errors
   * are collected per template key (or `templates[i]` without a usable key) as `<field>:<code>` or
   * `duplicate_key`. Duplicates are errors even when identical, so a copy cannot silently replace
   * the real template.
   */
  static create(
    definitions: readonly NotificationTemplateDefinition[],
  ): Result<TemplateRegistry, ValidationError> {
    const templates = new Map<string, NotificationTemplate>();
    const fieldErrors: Record<string, string[]> = {};
    const addError = (label: string, error: string): void => {
      const existing = (fieldErrors[label] ??= []);
      if (!existing.includes(error)) existing.push(error);
    };

    definitions.forEach((definition, index) => {
      const rawKey: unknown = (definition as { key?: unknown }).key;
      const key = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : null;
      const label = key ?? `templates[${index}]`;

      // Seen before if an earlier definition registered this key, or failed
      // validation under it (so it is in the error map, not the template map).
      if (key !== null && (templates.has(key) || Object.hasOwn(fieldErrors, key))) {
        addError(label, "duplicate_key");
      }

      const result = NotificationTemplate.create(definition);
      if (Result.isOk(result)) {
        templates.set(result.value.key, result.value);
        return;
      }
      for (const [field, codes] of Object.entries(result.error.fieldErrors)) {
        for (const code of codes) addError(label, `${field}:${code}`);
      }
    });

    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(
        new ValidationError("Notification template registry is invalid.", fieldErrors),
      );
    }
    return Result.ok(new TemplateRegistry(templates));
  }

  /**
   * Looks a template up by exact key. An unknown key is a `NotFoundError`
   * rather than `undefined` so the caller (Issue 264's `SendNotification`)
   * fails fast before anything is rendered or dispatched.
   */
  resolve(key: string): Result<NotificationTemplate, NotFoundError> {
    const template = this.templates.get(key);
    if (template === undefined) {
      return Result.err(new NotFoundError(`No notification template is registered for "${key}".`));
    }
    return Result.ok(template);
  }

  has(key: string): boolean {
    return this.templates.has(key);
  }
}
