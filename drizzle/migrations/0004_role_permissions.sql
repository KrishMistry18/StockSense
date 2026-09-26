-- ===========================================================================
--  0004 — role boundaries for document correction
--
--  The catalogue was already manager-only (products, warehouses and locations all
--  require is_manager), and any member could always create and validate movement
--  documents, which is right: recording stock movement is the job.
--
--  Reversing a validated document is different. It is an accounting correction
--  against closed history, so it belongs with a manager. A reversal is an ordinary
--  counter-document, distinguishable only by the marker the app writes into notes,
--  so the check keys off that marker.
--
--  Enforced here rather than by hiding a button, because a hidden button is not a
--  permission.
--
--  Re-runnable.
-- ===========================================================================

DROP POLICY IF EXISTS operations_insert ON public.operations;
CREATE POLICY operations_insert ON public.operations FOR INSERT TO authenticated
WITH CHECK (
  public.is_member(workspace_id)
  AND created_by = auth.uid()
  AND status = 'draft'
  -- Reversal documents are manager-only. Everything else is open to any member.
  AND (notes NOT LIKE 'Reversal of %' OR public.is_manager(workspace_id))
);

COMMENT ON POLICY operations_insert ON public.operations IS
  'Members may open draft documents. Reversal counter-documents require a manager.';
