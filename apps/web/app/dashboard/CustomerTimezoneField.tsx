import { updateContactTimezoneAction } from "../../lib/actions/timezone.js";
import { listSupportedTimezones } from "../../lib/timezoneList.js";

/**
 * Customer Timezone field for the conversation/handover "Contact details"
 * panel. Gated on canEdit (conversations.reply) -- the same permission
 * that already controls whether a staff member can reply to this
 * conversation at all -- so read-only staff still see the value but can't
 * change it. Never guesses a timezone; "Unknown" is a real, first-class
 * state, not a loading placeholder.
 */
export function CustomerTimezoneField({
  contactId,
  timezone,
  canEdit,
}: {
  contactId: string;
  timezone: string | null;
  canEdit: boolean;
}) {
  if (!canEdit) {
    return (
      <div>
        <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
          Customer timezone
        </dt>
        <dd style={{ margin: 0, fontSize: "0.85rem" }}>{timezone ?? "Unknown"}</dd>
      </div>
    );
  }

  const datalistId = `timezone-options-${contactId}`;

  return (
    <div>
      <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
        Customer timezone
      </dt>
      <dd style={{ margin: "0.3rem 0 0" }}>
        <form
          action={async (formData) => {
            "use server";
            const raw = String(formData.get("timezone") ?? "").trim();
            await updateContactTimezoneAction(contactId, raw.length > 0 ? raw : null);
          }}
          style={{ display: "flex", gap: "0.4rem" }}
        >
          <input
            name="timezone"
            list={datalistId}
            defaultValue={timezone ?? ""}
            placeholder="Unknown"
            className="dvx-input"
            style={{ flex: 1, fontSize: "0.8rem" }}
            autoComplete="off"
          />
          <datalist id={datalistId}>
            {listSupportedTimezones().map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <button
            className="dvx-button dvx-button--secondary"
            type="submit"
            style={{ fontSize: "0.75rem" }}
          >
            Save
          </button>
        </form>
      </dd>
    </div>
  );
}
