# Public Template Toggle

The Link Hub supports two public presentation templates stored in `stores.link_hub_config.publicTemplate`: `default` and `bento`.

- `default` uses `ClassicLinkHubRenderer` and `ClassicLinkHubEditor` for the stacked link-in-bio experience.
- `bento` uses the existing Bento renderer/editor and preserves the existing Bento document.
- Existing users without `publicTemplate` default to `default`.
- Switching templates only changes `publicTemplate`; links, collections, classic customization values, and Bento blocks remain persisted.
- The Studio API validates and persists classic link fields (`collectionId`, `layout`, `animate`), collections, and template selection.
- Classic public analytics uses the shared analytics identity, attribution, and event-id helpers from Build 21.
