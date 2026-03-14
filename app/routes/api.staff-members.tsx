// app/routes/api.staff-members.tsx
// POS UI Extensionからスタッフ一覧を取得するAPIエンドポイント

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";

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
    let { admin } = authResult;
    if (!admin) {
      return new Response(
        JSON.stringify({ ok: false, error: "Authentication failed" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    admin = withGraphQLRetry(admin);

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
    const staffList = nodes.map((s: { id?: string; name?: string; [key: string]: unknown }) => ({
      id: s.id,
      name: [s.firstName, s.lastName].filter(Boolean).join(" ") || s.email || s.id,
      email: s.email ?? "",
      active: s.active ?? true,
    }));

    return new Response(
      JSON.stringify({ ok: true, staffMembers: staffList }),
      {
        headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
      }
    );
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    const payload: { ok: false; error: string; stack?: string } = {
      ok: false,
      error: errMsg,
    };
    if (process.env.NODE_ENV !== "production" && e instanceof Error && e.stack) {
      payload.stack = e.stack;
    }
    return new Response(JSON.stringify(payload), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
