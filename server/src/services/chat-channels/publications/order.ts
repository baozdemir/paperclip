import {
  and,
  eq,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { type AnyPgColumn } from "drizzle-orm/pg-core";

type PublicationOrderTable = {
  createdAt: AnyPgColumn;
  id: AnyPgColumn;
  payload: AnyPgColumn;
};

function publicationTransportOrderKey(table: PublicationOrderTable) {
  return sql<string>`coalesce(${table.payload}->'transportPart'->>'orderKey', ${table.id}::text)`;
}

function publicationPrecedes(
  earlier: PublicationOrderTable,
  later: PublicationOrderTable,
) {
  return or(
    lt(earlier.createdAt, later.createdAt),
    and(
      eq(earlier.createdAt, later.createdAt),
      lt(
        publicationTransportOrderKey(earlier),
        publicationTransportOrderKey(later),
      ),
    ),
  );
}

// An unsent or unconfirmed publication holds every later one in its
// conversation. An unconfirmed progress indicator is the exception: a run's
// indicator (no comment) or an inbound "queued" notice (a wake key) carries no
// answer and is never replayed, so it must not hold the replies.
function holdsLaterPublications(table: {
  commentId: AnyPgColumn;
  idempotencyKey: AnyPgColumn;
  payload: AnyPgColumn;
  state: AnyPgColumn;
}) {
  return or(
    inArray(table.state, ["pending", "retry", "streaming"]),
    and(
      eq(table.state, "delivery_unknown"),
      sql`not (coalesce(${table.payload}->>'progressState', '') in ('queued', 'working') and (${table.commentId} is null or ${table.idempotencyKey} like 'wake:%:queued:%'))`,
    ),
  );
}

export { publicationTransportOrderKey, publicationPrecedes, holdsLaterPublications };
