# Prompt History

## 2026-10-07

> [00:40:35 (UTC-04:00)] so this repo is for completing the assignment for a cloudflare job application. it requires the prompt history for building this project. create an extension that auto captures my prompts into a PROMPTS.md file, appending my prompts with timestamps. with dates on it's own line.
> the extension should only work on this repo

> [00:46:38 (UTC-04:00)] also backfill the last prompt

> [00:50:38 (UTC-04:00)] i think the timestamp should just be on the begining of the line instead of a header

> [00:55:33 (UTC-04:00)] ok, so when i click the link on cloudflare ai powered application, there is this node module npm i agents. what's in it?

> [01:03:03 (UTC-04:00)] so i guess i should use this. also, the job description is 
> 
> About the Role
> Cloudflare’s Billing Engineering team builds and operates the systems responsible for usage metering, aggregation, subscriptions, invoicing, payments, and revenue recognition. These systems power billions in revenue and support millions of customers across Cloudflare’s product portfolio.
> 
> We are rebuilding key parts of our billing platform to scale with products including AI, Zero Trust, Workers, Bot Management, and DDoS Protection. As a Senior Software Engineer on the Fintech team, you will design reliable financial infrastructure, lead projects from requirements through production, and help ensure billing remains accurate as Cloudflare grows.
> 
> Responsibilities
> Build Billing Systems: Design, develop, and operate transactional microservices supporting metering, subscriptions, invoicing, payments, and financial workflows.
> 
> Own Projects End to End: Drive initiatives from requirements and technical design through implementation, testing, deployment, and ongoing operation.
> 
> Ensure Accuracy and Reliability: Build fault-tolerant systems that safely handle retries, failures, concurrency, and high transaction volumes while preserving financial correctness.
> 
> Maintain Operational Excellence: Monitor production services, investigate billing issues, improve observability, and address the underlying causes of recurring incidents.
> 
> Shape Technical Direction: Participate in architecture reviews, make pragmatic technical trade-offs, and help improve engineering standards across the billing platform.
> 
> Collaborate Cross-Functionally: Work with Product, Finance, Accounting, Support, and other engineering teams to turn complex business requirements into maintainable solutions.
> 
> Desirable Skills, Knowledge, and Experience
> - Five or more years of professional software engineering experience, or equivalent practical experience.
> 
> - Experience building and operating distributed systems or backend services in production.
> 
> - Proficiency in Go or another modern programming language, with an interest in working extensively with Go.
> 
> - Strong understanding of RESTful APIs, service security, and API standards such as OpenAPI, OAuth, or JWT.
> 
> - Working knowledge of SQL, data modeling, and relational databases such as PostgreSQL or MySQL.
> 
> - Experience designing secure, highly available microservices in Linux or Unix environments.
> 
> - Familiarity with event-driven architectures and asynchronous processing.
> 
> - Strong troubleshooting, communication, and project ownership skills.
> 
> Bonus Points
> - Experience with billing, payments, subscriptions, usage metering, invoicing, financial ledgers, or revenue recognition.
> 
> - Experience with technologies such as PostgreSQL, Redis, Kafka, Kubernetes, Docker, or Temporal.
> 
> - Familiarity with reconciliation, idempotency, auditability, and financial data integrity.
> 
> - Experience leading technically complex projects across multiple teams.
> 
> so we should make an application with topic on billing or payments. possibily with go

> [01:09:44 (UTC-04:00)] the assignment only says
> 
> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.
> 
> and the link takes me to https://developers.cloudflare.com/agents/
> 
> cannot find anything about naming convention for the repo

> [01:17:02 (UTC-04:00)] so help me understand what you are proposing. it's a billing system tracking customer usage (on cloud service or ai bills) and there is an agent that has customer data and help answer questions?

> [01:21:17 (UTC-04:00)] sounds reasonable because just like you said, the payment part should not depend on AI. i think this is enough for the assignment. 
> so other than typescript/node, should we build a frontend? and use db?

> [01:27:10 (UTC-04:00)] hmm, but i want an actual db that represents ground truth instead of every customer has their own billing data. they can still store their chat history in there. but billing should be global. 
> but yes, building the working chat agent first is fine.

> [01:39:05 (UTC-04:00)] commit and push

> [13:25:02 (UTC-04:00)] why choose a D1 for the billing single source of truth? can it be deployed locally?

> [13:27:50 (UTC-04:00)] what's the difference between D1 and regular local SQLite?

> [13:31:06 (UTC-04:00)] ok, sounds good. implement

> [13:49:31 (UTC-04:00)] prepare local testing

> [13:58:14 (UTC-04:00)] i ran setup, how do i see the UI

> [14:05:36 (UTC-04:00)] ok, then the next step

> [14:45:20 (UTC-04:00)] yes, commit

