-- Edges are validated once by kernel_data_query. Keep exact numeric arithmetic;
-- the final interval is closed, and overflow values are represented explicitly.
create or replace function kernel_read_aggregate_bin(amount numeric, edges jsonb)
returns jsonb language plpgsql immutable security invoker set search_path from current
as $kernel$
declare
  i integer;
  last_edge integer := jsonb_array_length(edges)-1;
begin
  if amount is null then return null; end if;
  if amount < (edges->>0)::numeric then return '"below"'::jsonb; end if;
  if amount > (edges->>last_edge)::numeric then return '"above"'::jsonb; end if;
  for i in 0..last_edge-1 loop
    if amount < (edges->>(i+1))::numeric or i=last_edge-1 then
      return jsonb_build_object('from',edges->i,'to',edges->(i+1));
    end if;
  end loop;
  return null;
end;
$kernel$
