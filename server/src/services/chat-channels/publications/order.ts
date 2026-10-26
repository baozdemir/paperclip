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
// conversation. An unconfirmed run progress indicator is the exception: it
// carries no answer and is never replayed, so it must not hold the replies.
function holdsLaterPublications(table: {
  commentId: AnyPgColumn;
  payload: AnyPgColumn;
  state: AnyPgColumn;
}) {
  return or(
    inArray(table.state, ["pending", "retry", "streaming"]),
    and(
      eq(table.state, "delivery_unknown"),
      sql`not (${table.commentId} is null and coalesce(${table.payload}->>'progressState', '') in ('queued', 'working'))`,
    ),
  );
}

export { publicationTransportOrderKey, publicationPrecedes, holdsLaterPublications };
