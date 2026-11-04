variable "project_id" {
  type        = string
  description = "GCP project id. Required. This repo does not commit a project id or project number."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project id (lowercase, 6-30 chars). Do not pass a numeric project number."
  }
}

variable "region" {
  type        = string
  description = "GCP region. The gcp-fit-v1 campaign is us-central1."
  default     = "us-central1"
}

variable "zone" {
  type        = string
  description = "Zone for the in-region k6 generator. Must stay inside var.region."
  default     = "us-central1-a"

  validation {
    condition     = startswith(var.zone, "${var.region}-")
    error_message = "zone must be inside var.region so the generator stays in-region."
  }
}

variable "credentials_json" {
  type        = string
  description = "Optional service-account JSON used by the Google provider. Empty uses Application Default Credentials. Do not commit a value."
  default     = ""
  sensitive   = true

  validation {
    condition     = var.credentials_json == "" || can(jsondecode(var.credentials_json))
    error_message = "credentials_json must be empty or a JSON object."
  }
}

variable "test_id" {
  type        = string
  description = "Campaign slug stamped on labels (test_id). Use the apply id."
  default     = "cwm-bench-unspecified"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,62}$", lower(replace(var.test_id, "_", "-"))))
    error_message = "test_id must become a GCP label value (lowercase, digits, hyphens, max 63)."
  }
}

variable "name_prefix" {
  type        = string
  description = "Name prefix for resources."
  default     = "cwm-bench"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,20}$", var.name_prefix))
    error_message = "name_prefix must be a short lowercase slug."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR. App subnet is the first /24; the private subnet is the second."
  default     = "10.42.0.0/16"
}

variable "app_count" {
  type        = number
  description = "Managed instance group size. gcp-fit-v1 is 2."
  default     = 2

  validation {
    condition     = var.app_count == floor(var.app_count) && var.app_count >= 1 && var.app_count <= 8
    error_message = "app_count must be an integer from 1 to 8."
  }
}

variable "app_machine_type" {
  type        = string
  description = "App machine type. gcp-fit-v1 is n2-standard-2 (2 vCPU, 8 GiB), the n2 shape used for this fit."
  default     = "n2-standard-2"
}

variable "app_image" {
  type        = string
  description = "Pinned boot image for the app MIG and the generator. Required at plan time. Do not commit a project-specific image id in this repo."

  validation {
    condition     = length(var.app_image) > 0 && !can(regex("[0-9]{12}", var.app_image))
    error_message = "app_image is required and must not embed a 12-digit project number."
  }
}

variable "app_root_volume_gb" {
  type        = number
  description = "Boot disk size (GiB) for each app VM. pd-balanced, not gp2. There is no BurstBalance metric."
  default     = 30
}

variable "app_pool_size" {
  type        = number
  description = "APP_POOL_SIZE on each app node. Default 250, same as the AWS typical app."
  default     = 250
}

variable "app_queue_limit" {
  type        = number
  description = "mysql2 queueLimit. Exhaustion is error class queue_full."
  default     = 50
}

variable "app_profile" {
  type        = string
  description = "Which app directory startup copies from the pinned SHA. gcp-fit-v1 uses typical."
  default     = "typical"

  validation {
    condition     = contains(["lean", "typical"], var.app_profile)
    error_message = "app_profile must be lean or typical."
  }
}

variable "app_workers" {
  type        = number
  description = "Node worker processes per app server. gcp-fit-v1 uses 2, same as the AWS typical app."
  default     = 2

  validation {
    condition     = var.app_workers == floor(var.app_workers) && var.app_workers >= 1 && var.app_workers <= 8
    error_message = "app_workers must be an integer from 1 to 8."
  }
}

variable "generator_machine_type" {
  type        = string
  description = "k6 generator machine type, in var.zone. Default c2-standard-4 (4 vCPU). This is the in-region compute-optimized shape used instead of c6i.xlarge; equivalence is not measured."
  default     = "c2-standard-4"
}

variable "k6_version" {
  type        = string
  description = "Pinned k6 release tag installed on the generator (linux amd64 tarball)."
  default     = "v0.54.0"
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL tier. Default db-custom-2-13312 is the largest valid 2 vCPU Enterprise custom tier (2 vCPU, 13312 MB = 13 GiB). db.r5.large is 2 vCPU and 16 GiB; 16 GiB is above the 6.5 GiB per vCPU cap, so this fit uses 13 GiB."
  default     = "db-custom-2-13312"
}

variable "db_disk_gb" {
  type        = number
  description = "Cloud SQL PD_SSD size (GiB). Not gp2, and not a BurstBalance source."
  default     = 100
}

variable "mysql_max_connections" {
  type        = number
  description = "Database flag max_connections. Default 500 matches the AWS typical declaration (2 x APP_POOL_SIZE=250). This is a declared flag, not a measured engine default."
  default     = 500

  validation {
    condition     = var.mysql_max_connections == floor(var.mysql_max_connections) && var.mysql_max_connections >= 1 && var.mysql_max_connections <= 100000
    error_message = "mysql_max_connections must be an integer from 1 to 100000."
  }
}

variable "mysql_max_prepared_stmt_count" {
  type        = number
  description = "Database flag max_prepared_stmt_count. Default 16382 is the MySQL 8.0 engine default; at the default the flag is not set, so the flag list is only max_connections."
  default     = 16382

  validation {
    condition     = var.mysql_max_prepared_stmt_count == floor(var.mysql_max_prepared_stmt_count) && var.mysql_max_prepared_stmt_count >= 0 && var.mysql_max_prepared_stmt_count <= 65528
    error_message = "mysql_max_prepared_stmt_count must be an integer from 0 to 65528."
  }
}

variable "db_username" {
  type        = string
  description = "Cloud SQL user."
  default     = "cwmbench"
}

variable "https_certificate" {
  type        = string
  description = "Optional SSL certificate self link. Empty keeps the external HTTP(S) load balancer on HTTP:80 only. Do not commit a certificate."
  default     = ""
}

variable "app_source_git_url" {
  type        = string
  description = "Exact git URL the startup script fetches. The gcp-fit runner does not use GitHub; pass the URL of the pinned commit's archive source you actually fetch."
  default     = "https://github.com/canvascloudai/cwm-bench.git"

  validation {
    condition     = var.app_source_git_url != ""
    error_message = "app_source_git_url must be the campaign repository URL."
  }
}

variable "app_source_git_ref" {
  type        = string
  description = "Exact commit SHA the startup script checks out. Empty or a branch name fails startup. gcp-fit-v1 uses the pinned merged commit."
  default     = ""

  validation {
    condition     = var.app_source_git_ref == "" || can(regex("^[0-9a-fA-F]{7,40}$", var.app_source_git_ref))
    error_message = "app_source_git_ref must be a git commit SHA (7-40 hex chars)."
  }
}
# CWM report re-trigger; do not merge.
