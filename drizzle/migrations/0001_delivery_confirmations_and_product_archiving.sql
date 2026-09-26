ALTER TABLE public.products ADD COLUMN archived boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.products.archived IS 'Archived products remain in historical documents and stock ledger.';
ALTER TABLE public.operations ADD COLUMN picked_at timestamptz;
ALTER TABLE public.operations ADD COLUMN packed_at timestamptz;
CREATE OR REPLACE FUNCTION public.advance_operation(op_id uuid, next_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE o public.operations%ROWTYPE; item public.operation_items%ROWTYPE; old_quantity numeric; count_items integer;
BEGIN
 SELECT * INTO o FROM public.operations WHERE id=op_id FOR UPDATE;
 IF o.id IS NULL OR NOT public.is_member(o.workspace_id) THEN RAISE EXCEPTION 'Operation not found'; END IF;
 IF o.status IN ('done','canceled') THEN RAISE EXCEPTION 'This operation is closed'; END IF;
 IF next_status='canceled' THEN UPDATE public.operations SET status='canceled' WHERE id=op_id; RETURN; END IF;
 IF o.kind='delivery' THEN
   IF next_status='waiting' THEN
     IF o.status<>'draft' THEN RAISE EXCEPTION 'Pick is only available for a draft delivery'; END IF;
     IF o.source_location_id IS NULL THEN RAISE EXCEPTION 'Select a stock location'; END IF;
     SELECT count(*) INTO count_items FROM public.operation_items WHERE operation_id=op_id;
     IF count_items=0 THEN RAISE EXCEPTION 'Add at least one product'; END IF;
     FOR item IN SELECT * FROM public.operation_items WHERE operation_id=op_id LOOP
       IF item.quantity<=0 OR item.quantity>coalesce((SELECT quantity FROM public.stock_balances WHERE product_id=item.product_id AND location_id=o.source_location_id),0) THEN RAISE EXCEPTION 'Not enough stock to pick this delivery'; END IF;
     END LOOP;
     UPDATE public.operations SET status='waiting',picked_at=now() WHERE id=op_id; RETURN;
   ELSIF next_status='ready' THEN
     IF o.status<>'waiting' THEN RAISE EXCEPTION 'Confirm picking before packing'; END IF;
     UPDATE public.operations SET status='ready',packed_at=now() WHERE id=op_id; RETURN;
   ELSIF next_status='done' AND o.status<>'ready' THEN RAISE EXCEPTION 'Confirm packing before dispatch'; END IF;
 ELSIF next_status IN ('waiting','ready') THEN
   IF o.status NOT IN ('draft','waiting') THEN RAISE EXCEPTION 'Invalid status change'; END IF;
   UPDATE public.operations SET status=next_status WHERE id=op_id; RETURN;
 END IF;
 IF next_status<>'done' THEN RAISE EXCEPTION 'Invalid status'; END IF;
 IF o.kind='receipt' AND o.destination_location_id IS NULL OR o.kind IN ('delivery','adjustment','transfer') AND o.source_location_id IS NULL OR o.kind='transfer' AND (o.destination_location_id IS NULL OR o.destination_location_id=o.source_location_id) THEN RAISE EXCEPTION 'Select valid stock locations'; END IF;
 SELECT count(*) INTO count_items FROM public.operation_items WHERE operation_id=op_id;
 IF count_items=0 THEN RAISE EXCEPTION 'Add at least one product'; END IF;
 FOR item IN SELECT * FROM public.operation_items WHERE operation_id=op_id ORDER BY product_id LOOP
   IF item.quantity<=0 AND o.kind<>'adjustment' THEN RAISE EXCEPTION 'Quantities must be greater than zero'; END IF;
   IF o.kind='receipt' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.destination_location_id,item.quantity);
   ELSIF o.kind='delivery' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,-item.quantity);
   ELSIF o.kind='transfer' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,-item.quantity); PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.destination_location_id,item.quantity);
   ELSE IF item.counted_quantity IS NULL THEN RAISE EXCEPTION 'Enter the counted quantity'; END IF;
     SELECT coalesce(quantity,0) INTO old_quantity FROM public.stock_balances WHERE product_id=item.product_id AND location_id=o.source_location_id;
     PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,item.counted_quantity-coalesce(old_quantity,0));
   END IF;
 END LOOP;
 UPDATE public.operations SET status='done',completed_at=now() WHERE id=op_id;
END $function$;
CREATE OR REPLACE FUNCTION public.discard_draft_operation(op_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE o public.operations%ROWTYPE;
BEGIN
 SELECT * INTO o FROM public.operations WHERE id=op_id FOR UPDATE;
 IF o.id IS NULL OR o.status<>'draft' OR NOT public.is_member(o.workspace_id) THEN RAISE EXCEPTION 'Only a workspace draft can be discarded'; END IF;
 DELETE FROM public.operation_items WHERE operation_id=op_id;
 DELETE FROM public.operations WHERE id=op_id;
END $function$;
GRANT EXECUTE ON FUNCTION public.discard_draft_operation(uuid) TO authenticated;