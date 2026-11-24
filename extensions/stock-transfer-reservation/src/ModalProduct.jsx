import { render } from "preact";
import { ReservationModal } from "./Modal.jsx";
export default async () => render(<ReservationModal fromProduct initialProduct={shopify.product} />, document.body);
