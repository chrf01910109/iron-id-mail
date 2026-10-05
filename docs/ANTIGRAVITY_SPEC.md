\# TASK: IRON ID Webmail Frontend Client Integration



\## Objective

Build and mount the IRON ID Workspace Webmail UI. Connect to the local Stalwart Mail Server via RFC 8620/8621 JMAP protocol with zero-hop local domain delivery.



\## Target Environment \& Endpoints

\- Engine: Stalwart Mail Server 0.16 (Rust/RocksDB)

\- Backend Service: http://127.0.0.1:8080

\- JMAP Session Endpoint: GET http://127.0.0.1:8080/jmap/session

\- JMAP Call Endpoint: POST http://127.0.0.1:8080/jmap

\- Auth Scheme: HTTP Basic (`Authorization: Basic base64(email:password)`)



\## Verified User Directory

1\. Tenant Primary:

&#x20;  - Email: charaf@iron-id.io

&#x20;  - Password: Ch@r@firon-!D

2\. Tenant Client:

&#x20;  - Email: anis@client.dz

&#x20;  - Password: anistestmail



\## Critical Protocol Rules (RFC 8620 / 8621)

1\. DO NOT query `/.well-known/jmap` without handling HTTP 307 redirects, or Authorization headers will be stripped. Use `/jmap/session` directly.

2\. In atomic send workflows, use `#msg1` backreferencing between `Email/set` and `EmailSubmission/set`.

3\. Standard Send Payload:

```json

{

&#x20; "using": \[

&#x20;   "urn:ietf:params:jmap:core",

&#x20;   "urn:ietf:params:jmap:mail",

&#x20;   "urn:ietf:params:jmap:submission"

&#x20; ],

&#x20; "methodCalls": \[

&#x20;   \[

&#x20;     "Email/set",

&#x20;     {

&#x20;       "accountId": "<ACCOUNT\_ID>",

&#x20;       "create": {

&#x20;         "msg1": {

&#x20;           "mailboxIds": { "<SENT\_OR\_INBOX\_ID>": true },

&#x20;           "from": \[{ "name": "Sender", "email": "sender@domain" }],

&#x20;           "to": \[{ "name": "Recipient", "email": "rcpt@domain" }],

&#x20;           "subject": "Subject Line",

&#x20;           "bodyValues": { "b1": { "value": "Plaintext content", "isTruncated": false } },

&#x20;           "textBody": \[{ "partId": "b1", "type": "text/plain" }]

&#x20;         }

&#x20;       }

&#x20;     },

&#x20;     "draft"

&#x20;   ],

&#x20;   \[

&#x20;     "EmailSubmission/set",

&#x20;     {

&#x20;       "accountId": "<ACCOUNT\_ID>",

&#x20;       "create": {

&#x20;         "sub1": {

&#x20;           "identityId": "<IDENTITY\_ID>",

&#x20;           "emailId": "#msg1",

&#x20;           "envelope": {

&#x20;             "mailFrom": { "email": "sender@domain" },

&#x20;             "rcptTo": \[{ "email": "rcpt@domain" }]

&#x20;           }

&#x20;         }

&#x20;       }

&#x20;     },

&#x20;     "submit"

&#x20;   ]

&#x20; ]

}

