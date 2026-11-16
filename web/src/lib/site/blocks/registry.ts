import type { BlockSpec } from "./block";
import type { Fields } from "./fields";
import { Banner, Columns, Divider, Section, Spacer } from "./layout";
import { Gallery, Picture, Video } from "./pictures";
import { AddonPrices, ContactDetails, ContactForm, LocationCard, RateCards, StudioCards, StudioDetails } from "./site-data";
import { Buttons, Cards, Heading, Questions, Table, Text } from "./text";

/**
 * Every block a page can be made of, by the name a page stores it under.
 * A name is part of every page that uses the block: never rename one, and
 * never remove one that a stored page may still hold (`parsePage` drops a
 * block it does not know).
 *
 * To add a block: describe it with `defineBlock` and list it here. The
 * editor's form, its starting values and its validity check all follow from
 * the description.
 */
export const BLOCKS = {
  Banner,
  Section,
  Columns,
  Heading,
  Text,
  Buttons,
  Picture,
  Gallery,
  Video,
  Cards,
  Questions,
  Table,
  Spacer,
  Divider,
  StudioCards,
  StudioDetails,
  RateCards,
  AddonPrices,
  ContactDetails,
  LocationCard,
  ContactForm,
} as const;

export type BlockName = keyof typeof BLOCKS;

export const BLOCK_NAMES = Object.keys(BLOCKS) as BlockName[];

/** The description of a block by its stored name, or undefined for a name no block has. */
export function blockSpec(name: unknown): BlockSpec<Fields> | undefined {
  return typeof name === "string" && Object.hasOwn(BLOCKS, name) ? (BLOCKS[name as BlockName] as unknown as BlockSpec<Fields>) : undefined;
}
