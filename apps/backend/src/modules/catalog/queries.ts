// Admin GraphQL documents (SPEC 8.5). Product.images and Product.featuredImage are deprecated, so
// images come from media filtered to IMAGE (the media_type filter exists since API 2024-04).
const SNAPSHOT_FIELDS = /* GraphQL */ `
  fragment ProductSnapshotFields on Product {
    id
    title
    handle
    descriptionHtml
    productType
    vendor
    tags
    options {
      name
      values
    }
    featuredMedia {
      preview {
        image {
          url
        }
      }
    }
    media(first: 5, query: "media_type:IMAGE") {
      nodes {
        ... on MediaImage {
          image {
            url
          }
        }
      }
    }
  }
`;

export const PRODUCT_LIST_QUERY = /* GraphQL */ `
  query ProductList($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        status
        vendor
        productType
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        mediaCount {
          count
        }
        variantsCount {
          count
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const PRODUCT_DETAIL_QUERY = /* GraphQL */ `
  query ProductDetail($id: ID!) {
    product(id: $id) {
      ...ProductSnapshotFields
    }
  }
  ${SNAPSHOT_FIELDS}
`;

export const PRODUCT_SNAPSHOTS_QUERY = /* GraphQL */ `
  query ProductSnapshots($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        ...ProductSnapshotFields
      }
    }
  }
  ${SNAPSHOT_FIELDS}
`;
