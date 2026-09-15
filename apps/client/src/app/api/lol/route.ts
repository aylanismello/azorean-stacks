/**
 * The route, and nothing but the route. Everything it does lives in the
 * sub-app's own folder (`src/lol`), so moving the board somewhere else is
 * deleting this file rather than untangling one.
 */
export { GET, POST, PATCH, DELETE, dynamic } from "@/lol/server";
