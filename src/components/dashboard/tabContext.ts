"use client";

import { createContext, useContext } from "react";

/**
 * Which dashboard tab is showing. The Today tab stays mounted while another tab
 * is open (hidden, not removed) so its 3D map is not torn down and rebuilt on
 * every visit; the map reads this to stop rendering frames while it is out of
 * sight.
 */
export const ActiveTabContext = createContext<string>("today");
export const useActiveTab = () => useContext(ActiveTabContext);
