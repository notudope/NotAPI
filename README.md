# NotAPI

> A simple **multi-featured** API.

## morse

```sh
curl https://notapi.vercel.app/api/morse?en=SOS
> {"input":"SOS","result":"... --- ..."}

curl https://notapi.vercel.app/api/morse?de=...+---+...
> {"input":"... --- ...","result":"SOS"}
```

## romans

```sh
curl https://notapi.vercel.app/api/romans?en=454
> {"input":"454","result":"CDLIV"}

curl https://notapi.vercel.app/api/romans?de=CDLIV
> {"input":"CDLIV","result":"454"}
```

## spamwatch

```sh
curl https://notapi.vercel.app/api/spamwatch?id=5092924615

> {"error":"","id":5092924615,"reason":"Kriminalamt #1288027810 No. 1","date":"2022-03-21T00:52:14.000Z","timestamp":1647823934,"admin":3,"message":null}
```

## lyrics

```sh
curl https://notapi.vercel.app/api/lyrics?q=brian

> {"error":"","title":"Dat $tick","artist":"Rich Brian","url":"https://genius.com/Rich-brian-dat-stick-lyrics","lyrics":"[Verse 1]\nTw-tw-tw-twelve in the mornin', pop shells for a livin'..."}
```
