/**
 * Reversing a validated stock document.
 *
 * Nothing is ever deleted or edited. A reversal posts a *counter-document* that moves the same
 * quantities the opposite way, so both the original and the correction stay in the ledger and the
 * history still reconciles. That is the only way an audit trail can be trusted.
 *
 * The counter-document is derived from the original's ledger legs rather than from its line items,
 * so it stays correct even when the document was partially consumed by later movements.
 */

import { supabase } from "@/integrations/supabase/client";

export type ReversibleOperation = {
  id: string;
  reference: string;
  kind: string;
  status: string;
  contact: string;
  source_location_id: string | null;
  destination_location_id: string | null;
  notes?: string;
};

const NOTE_PREFIX = "Reversal of";

export function reversalNote(reference: string, reason: string): string {
  return `${NOTE_PREFIX} ${reference}. Reason: ${reason}`;
}

/** Reads the reversal marker back out of a document's notes. */
export function parseReversal(
  notes: string | null | undefined,
): { reference: string; reason: string } | null {
  if (!notes || !notes.startsWith(`${NOTE_PREFIX} `)) return null;
  const match = /^Reversal of (.+?)\. Reason: ([\s\S]*)$/.exec(notes);
  if (!match) return null;
  const [, reference, reason] = match;
  if (!reference) return null;
  return { reference, reason: reason ?? "" };
}

/** Finds the document that already reverses `reference`, if there is one. */
export function findReversal<T extends { reference: string; status: string; notes?: string }>(
  operations: T[],
  reference: string,
): T | undefined {
  return operations.find(
    (o) => o.status !== "canceled" && parseReversal(o.notes)?.reference === reference,
  );
}

export function canReverse(operation: ReversibleOperation): boolean {
  return operation.status === "done";
}

type Leg = { product_id: string; location_id: string; delta: number };
type CounterLine = { product_id: string; quantity: number; counted_quantity: number | null };
type CounterDocument = {
  kind: string;
  source: string | null;
  destination: string | null;
  lines: CounterLine[];
};

/** Sums ledger legs per product/location so a multi-line document collapses to one entry each. */
function groupLegs(
  legs: Leg[],
): Map<string, { product_id: string; location_id: string; delta: number }> {
  const grouped = new Map<string, { product_id: string; location_id: string; delta: number }>();
  for (const leg of legs) {
    const key = `${leg.product_id}:${leg.location_id}`;
    const existing = grouped.get(key);
    if (existing) existing.delta += Number(leg.delta);
    else
      grouped.set(key, {
        product_id: leg.product_id,
        location_id: leg.location_id,
        delta: Number(leg.delta),
      });
  }
  return grouped;
}

function buildCounterDocument(
  operation: ReversibleOperation,
  legs: Leg[],
  balanceAt: (productId: string, locationId: string) => number,
): CounterDocument {
  const grouped = [...groupLegs(legs).values()].filter((leg) => leg.delta !== 0);
  if (!grouped.length)
    throw new Error("This document did not move any stock, so there is nothing to reverse.");

  if (operation.kind === "receipt") {
    // Stock arrived at the destination; send the same quantities back out of it.
    const lines = grouped
      .filter((leg) => leg.delta > 0)
      .map((leg) => ({ product_id: leg.product_id, quantity: leg.delta, counted_quantity: null }));
    const location =
      grouped.find((leg) => leg.delta > 0)?.location_id ?? operation.destination_location_id;
    return { kind: "delivery", source: location, destination: null, lines };
  }

  if (operation.kind === "delivery") {
    // Stock left the source; put the same quantities back into it.
    const lines = grouped
      .filter((leg) => leg.delta < 0)
      .map((leg) => ({ product_id: leg.product_id, quantity: -leg.delta, counted_quantity: null }));
    const location =
      grouped.find((leg) => leg.delta < 0)?.location_id ?? operation.source_location_id;
    return { kind: "receipt", source: null, destination: location, lines };
  }

  if (operation.kind === "transfer") {
    // Move it straight back, so the counter-document is the same transfer with the ends swapped.
    const perProduct = new Map<string, number>();
    for (const leg of grouped) {
      if (leg.delta > 0)
        perProduct.set(leg.product_id, (perProduct.get(leg.product_id) ?? 0) + leg.delta);
    }
    const lines = [...perProduct.entries()].map(([product_id, quantity]) => ({
      product_id,
      quantity,
      counted_quantity: null,
    }));
    return {
      kind: "transfer",
      source: operation.destination_location_id,
      destination: operation.source_location_id,
      lines,
    };
  }

  if (operation.kind === "adjustment") {
    // Re-apply the opposite correction against whatever the balance is *now*, so later movements
    // are preserved instead of being silently overwritten.
    const lines = grouped.map((leg) => {
      const current = balanceAt(leg.product_id, leg.location_id);
      const target = current - leg.delta;
      if (target < 0) {
        throw new Error(
          "Reversing this count would push stock below zero because of later movements. Post a new adjustment instead.",
        );
      }
      return { product_id: leg.product_id, quantity: current, counted_quantity: target };
    });
    const location = grouped[0]?.location_id ?? operation.source_location_id;
    return { kind: "adjustment", source: location, destination: null, lines };
  }

  throw new Error(`Documents of type "${operation.kind}" cannot be reversed automatically.`);
}

/** A counter-delivery has to walk the pick/pack/dispatch steps the same way a real one does. */
function advanceSteps(kind: string): string[] {
  return kind === "delivery" ? ["waiting", "ready", "done"] : ["done"];
}

/**
 * Posts the counter-document for `operation` and validates it, leaving both documents in place.
 * Returns the new document's reference.
 */
export async function reverseOperation(input: {
  workspaceId: string;
  operation: ReversibleOperation;
  reason: string;
  balanceAt: (productId: string, locationId: string) => number;
}): Promise<string> {
  const { workspaceId, operation, reason } = input;
  const trimmedReason = reason.trim();
  if (!canReverse(operation)) throw new Error("Only a validated document can be reversed.");
  if (trimmedReason.length < 3)
    throw new Error("Enter a reason for the reversal — it is recorded in the audit trail.");

  const { data: legs, error: legError } = await supabase
    .from("stock_ledger")
    .select("product_id,location_id,delta")
    .eq("workspace_id", workspaceId)
    .eq("operation_id", operation.id);
  if (legError) throw new Error(legError.message);

  const counter = buildCounterDocument(operation, (legs ?? []) as Leg[], input.balanceAt);
  if (!counter.lines.length) throw new Error("This document has no movements left to reverse.");

  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData.user?.id;
  if (!createdBy) throw new Error("Sign in again to reverse this document.");

  const { data: created, error: createError } = await supabase
    .from("operations")
    .insert({
      workspace_id: workspaceId,
      reference: `REV/${operation.reference}`,
      kind: counter.kind,
      status: "draft",
      contact: operation.contact,
      source_location_id: counter.source,
      destination_location_id: counter.destination,
      notes: reversalNote(operation.reference, trimmedReason),
      created_by: createdBy,
    })
    .select("id,reference")
    .single();
  if (createError) throw new Error(`Could not open the reversal document: ${createError.message}`);

  const { error: lineError } = await supabase.from("operation_items").insert(
    counter.lines.map((line) => ({
      workspace_id: workspaceId,
      operation_id: created.id,
      product_id: line.product_id,
      quantity: line.quantity,
      counted_quantity: line.counted_quantity,
    })),
  );
  if (lineError) {
    await supabase.rpc("discard_draft_operation", { op_id: created.id });
    throw new Error(`Could not add lines to the reversal: ${lineError.message}`);
  }

  for (const step of advanceSteps(counter.kind)) {
    const { error: advanceError } = await supabase.rpc("advance_operation", {
      op_id: created.id,
      next_status: step,
    });
    if (advanceError) {
      // The draft is only discardable while it is still a draft; past that it stays visible so the
      // half-finished correction is never hidden from whoever has to sort it out.
      if (step === advanceSteps(counter.kind)[0]) {
        await supabase.rpc("discard_draft_operation", { op_id: created.id });
      }
      throw new Error(`Reversal could not be validated: ${advanceError.message}`);
    }
  }

  return created.reference;
}
