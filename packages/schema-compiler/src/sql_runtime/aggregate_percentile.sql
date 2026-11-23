-- Continuous percentile with numeric interpolation, without converting decimal
-- amounts to float8. Input is sorted and null-free by the calling aggregate.
create or replace function kernel_read_aggregate_percentile(amounts numeric[], p numeric)
returns numeric language plpgsql immutable security invoker set search_path from current
as $kernel$
declare
  rank_position numeric;
  lower_index integer;
begin
  if coalesce(cardinality(amounts),0)=0 then return null; end if;
  rank_position := 1 + (cardinality(amounts)-1)*p;
  lower_index := floor(rank_position)::integer;
  if lower_index=cardinality(amounts) then return amounts[lower_index]; end if;
  return amounts[lower_index] + (amounts[lower_index+1]-amounts[lower_index])*(rank_position-lower_index);
end;
$kernel$
