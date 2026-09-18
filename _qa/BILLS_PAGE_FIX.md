# Bills page fix

Fixed runtime `TypeError: object is not iterable` in `configLines()` by normalizing JSONB selection values before iteration. Build 16's `selected_options` column can contain an object (including the existing `{}` default), while the UI assumed an array.

The page now safely handles arrays, object-shaped single selections, object maps containing selection objects, null, and unexpected scalar values without crashing.
