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
    console.log("[api.staff-members] Request received");
    
    // POS UI Extensionからのセッショントークンで認証
    const authResult = await authenticate.public(request);
    console.log("[api.staff-members] Authentication successful");
    
    const { admin } = authResult;

    const response = await admin.graphql(STAFF_MEMBERS_QUERY, {
      variables: { first: 250 },
    });

    const result = await response.json();
    console.log("[api.staff-members] GraphQL response:", JSON.stringify(result, null, 2));

    if (result.errors && result.errors.length > 0) {
      console.error("[api.staff-members] StaffMembers query errors:", result.errors);
      return new Response(
        JSON.stringify({ ok: false, error: "Failed to fetch staff members", details: result.errors }),
        { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const nodes = result.data?.staffMembers?.nodes ?? [];
    console.log("[api.staff-members] Staff nodes count:", nodes.length);
    
    const staffList = nodes.map((s: any) => ({
      id: s.id,
      name: [s.firstName, s.lastName].filter(Boolean).join(" ") || s.email || s.id,
      email: s.email ?? "",
      active: s.active ?? true,
    }));

    console.log("[api.staff-members] Returning staff list:", staffList.length, "items");
    return new Response(
      JSON.stringify({ ok: true, staffMembers: staffList }),
      { 
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (e: any) {
    console.error("[api.staff-members] Exception:", e?.message || e, e);
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Unknown error", stack: e?.stack }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
