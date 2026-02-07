// app/routes/api.staff-members.tsx
// POS UI Extensionからスタッフ一覧を取得するAPIエンドポイント

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const STAFF_MEMBERS_QUERY = `#graphql
  query StaffMembers($first: Int!) {
    staffMembers(first: $first) {
      nodes {
        id
        email
        firstName
        lastName
        active
      }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticate.public(request);
    const { admin } = authResult;

    const response = await admin.graphql(STAFF_MEMBERS_QUERY, {
      variables: { first: 250 },
    });

    const result = await response.json();

    if (result.errors && result.errors.length > 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "Failed to fetch staff members", details: result.errors }),
        { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const nodes = result.data?.staffMembers?.nodes ?? [];
    const staffList = nodes.map((s: any) => ({
      id: s.id,
      name: [s.firstName, s.lastName].filter(Boolean).join(" ") || s.email || s.id,
      email: s.email ?? "",
      active: s.active ?? true,
    }));

    return new Response(
      JSON.stringify({ ok: true, staffMembers: staffList }),
      { 
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Unknown error", stack: e?.stack }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
