# Catalog API

## Goal
Read-only product catalog with cursor pagination.

## Endpoints
- `GET /catalog/products?category=&min_price=&max_price=&cursor=`
- `GET /catalog/products/:id`

## Requirements
- Cursor pagination, 24 items per page
- Responses cached 60s at the edge
