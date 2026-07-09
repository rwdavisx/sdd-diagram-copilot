# Product List

## Goal
Browseable, filterable grid of products backed by the Catalog API.

## Requirements
- Grid layout, 4 columns desktop / 2 mobile
- Filters: category, price range; state reflected in URL query params
- Infinite scroll via `GET /catalog/products?cursor=...`
- Skeleton loaders while fetching

## Open questions
- Do we need server-side search at launch, or is category filtering enough?
