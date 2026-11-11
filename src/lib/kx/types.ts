// Short names for the API shapes this app uses. Every type comes from
// api-types.ts, which is generated from openapi/openapi.v1.json (`pnpm gen:api`).
//
// Decimals are strings and stay strings: never parse an amount into a float to
// send it back to the API.

import type { components } from './api-types';

type Schemas = components['schemas'];

export type Lang = Schemas['Lang'];
export type RateType = Schemas['RateType'];
export type AmountType = Schemas['AmountType'];
export type Icon = Schemas['Icon'];
export type Warning = Schemas['Warning'];
export type Provider = Schemas['Provider'];
export type SourceNotice = Schemas['SourceNotice'];

export type Source = Schemas['Source'];
/** A quote's source block (top level and fallback_sources): Source + refund_address_forwarding. */
export type QuoteSource = Schemas['QuoteSource'];
export type OrderSource = Schemas['OrderSource'];
export type RefundAddressForwarding = Schemas['RefundAddressForwarding'];
export type SourceInfo = Schemas['SourceInfo'];
export type SourceList = Schemas['SourceList'];

export type Currency = Schemas['Currency'];
export type CurrencyNetwork = Schemas['CurrencyNetwork'];
export type CurrencyList = Schemas['CurrencyList'];

export type QuoteRequest = Schemas['QuoteRequest'];
export type Quote = Schemas['Quote'];
export type FallbackSource = Schemas['FallbackSource'];

export type OrderRequest = Schemas['OrderRequest'];
export type Order = Schemas['Order'];
export type OrderStatus = Schemas['OrderStatus'];
export type StatusDetail = Schemas['StatusDetail'];

export type ValidateAddressRequest = Schemas['ValidateAddressRequest'];
export type AddressValidation = Schemas['AddressValidation'];

export type ApiErrorBody = Schemas['ErrorBody'];

/** The four order fields an address or memo error can point at. */
export type AddressField = 'to_address' | 'to_memo' | 'refund_address' | 'refund_memo';
