# @rosen-clients/ergo-explorer

## Table of contents

- [Introduction](#introduction)
- [Installation](#installation)
- [Usage](#usage)

## Introduction

`@rosen-clients/ergo-explorer` is an Ergo Explorer client library. It is created
by latest OpenAPI spec of Ergo Explorer and is the main client library which
powers Rosen Bridge.

## Installation

npm:

```sh
npm i @rosen-clients/ergo-explorer
```

yarn:

```sh
yarn add @rosen-clients/ergo-explorer
```

## Usage

```ts
import ergoExplorerClientFactory from '@rosen-clients/ergo-explorer';

const ergoExplorerClient = ergoExplorerClientFactory('YOUR_EXPLORER_URL');

// `ergoExplorerClient` contains all of the apis categorized by their tag, e.g.
ergoExplorerClient.v0.getApiV0BlocksP1('SOME_BLOCK_HASH');
ergoExplorerClient.v1.getApiV1BoxesByaddressP1('SOME_ADDRESS');
```
