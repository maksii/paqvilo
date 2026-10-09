# Synthetic code site (.powerpages-site)

A small Power Pages code site in the short-key `.powerpages-site` layout that `pac pages
download-code-site` writes: unprefixed keys with record IDs in `id:`, language copies under
`content-pages/<language>/` and `content-snippets/<name>/<language>/`, one folder per web file,
portal languages in `.portalconfig/*.portallanguage.yml`, and the `bot-consumers/`,
`cloud-flow-consumer/`, `server-logic/` and `source-files/` folders.

The records, names, IDs (`5c0de51e-…`) and file contents are synthetic. The folder layout and
field names follow the code sites in microsoft/power-pages-samples
(https://github.com/microsoft/power-pages-samples), which is published under the MIT License:

> MIT License
>
> Copyright (c) Microsoft Corporation.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The site has two pages (Home with English and Canadian French copies, About with an English
copy restricted to authenticated users), two site languages whose codes come only from
`.portalconfig` (fr-CA has a site language name that the portal-language catalogue does not
know), a page template with header and footer web templates, a content snippet in both
languages, two web files, three web roles, a contact table permission, a site marker, a web link
set, a bot consumer, a cloud flow consumer, a server logic record with its code, and a code-site
source file record. Its data model is not recorded, as in every `.powerpages-site` export.
