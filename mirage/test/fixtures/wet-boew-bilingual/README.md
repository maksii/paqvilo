# wet-boew bilingual fixture

A subset of the GCWeb Power Pages template by Alfred Ofosu, used unmodified as a real
bilingual (English/French) portal export for the selected-language tests in
`test/liquid-portal-parity.test.mjs`.

- Source: https://github.com/alfredofosu/wet-boew-power-pages-template
- Commit: `b568a615fa2c77a0f976170e41f3fc05f3ff551e` (2025-09-01)
- Path: `enhanced-data-model/gcweb-power-pages-template`
- Licence: MIT, see `LICENSE` in this folder (Copyright (c) 2024 Alfred Ofosu)

Files copied without changes: `website.yml`, `websitelanguage.yml`, `publishingstate.yml`,
`sitesetting.yml`, `.portalconfig/portallanguage.yml`, the `home` and `overview` web pages with
their English and French content pages, the `GCWeb/App/Page/Default` page template, the web
templates `GCWeb/App/Header`, `GCWeb/App/Page/Default`, `GCWeb/App/Page/Title` and
`Languages Dropdown`, six content snippets in both languages and the `Default` web link sets.
The other pages, templates, snippets and web files of the source are not included.

The export shows the enhanced data model's language records: each website language has the
same ID as its portal language (`adx_websitelanguageid` = `adx_portallanguageid`), and the
language codes (`en`, `fr`), LCIDs and display names come from `.portalconfig/portallanguage.yml`.
