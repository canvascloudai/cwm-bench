locals {
  dashboard_name = "${local.name}-${local.id_slug}"

  dashboard_body = jsonencode({
    widgets = concat(
      [
        {
          type   = "text"
          x      = 0
          y      = 0
          width  = 24
          height = 2
          properties = {
            markdown = <<-MD
              # cwm-bench ${var.test_id}
              Canonical topology metrics. These widgets are empty of meaning until a campaign runs.
              **Do not** treat this dashboard as a measured result by itself.
              BurstBalance = 0 is the **iops_throttle** bucket — not CPU, not DB connections.
            MD
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 2
          width  = 12
          height = 6
          properties = {
            title  = "EC2 CPUUtilization per app node"
            region = var.region
            stat   = "Average"
            period = 60
            metrics = [
              for id in aws_instance.app[*].id : ["AWS/EC2", "CPUUtilization", "InstanceId", id]
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 2
          width  = 12
          height = 6
          properties = {
            title  = "RDS CPUUtilization"
            region = var.region
            stat   = "Average"
            period = 60
            metrics = [
              ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier]
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 8
          width  = 12
          height = 6
          properties = {
            title  = "RDS DatabaseConnections"
            region = var.region
            stat   = "Average"
            period = 60
            metrics = [
              ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.main.identifier]
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 8
          width  = 12
          height = 6
          properties = {
            title  = "RDS BurstBalance (gp2). 0 => iops_throttle bucket"
            region = var.region
            stat   = "Minimum"
            period = 60
            metrics = [
              ["AWS/RDS", "BurstBalance", "DBInstanceIdentifier", aws_db_instance.main.identifier]
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 14
          width  = 12
          height = 6
          properties = {
            title  = "RDS FreeableMemory"
            region = var.region
            stat   = "Average"
            period = 60
            metrics = [
              ["AWS/RDS", "FreeableMemory", "DBInstanceIdentifier", aws_db_instance.main.identifier]
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 14
          width  = 12
          height = 6
          properties = {
            title  = "App EBS BurstBalance (gp2 root). 0 => iops_throttle bucket"
            region = var.region
            stat   = "Minimum"
            period = 60
            metrics = [
              for vol in aws_instance.app[*].root_block_device[0].volume_id :
              ["AWS/EBS", "BurstBalance", "VolumeId", vol]
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 20
          width  = 12
          height = 6
          properties = {
            title  = "ALB RequestCount"
            region = var.region
            stat   = "Sum"
            period = 60
            metrics = [
              ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix]
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 20
          width  = 12
          height = 6
          properties = {
            title  = "ALB TargetResponseTime"
            region = var.region
            stat   = "p95"
            period = 60
            metrics = [
              ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix]
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 26
          width  = 8
          height = 6
          properties = {
            title  = "ALB HTTPCode_Target_2XX"
            region = var.region
            stat   = "Sum"
            period = 60
            metrics = [
              ["AWS/ApplicationELB", "HTTPCode_Target_2XX_Count", "LoadBalancer", aws_lb.main.arn_suffix]
            ]
          }
        },
        {
          type   = "metric"
          x      = 8
          y      = 26
          width  = 8
          height = 6
          properties = {
            title  = "ALB HTTPCode_Target_5XX"
            region = var.region
            stat   = "Sum"
            period = 60
            metrics = [
              ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix]
            ]
          }
        },
        {
          type   = "metric"
          x      = 16
          y      = 26
          width  = 8
          height = 6
          properties = {
            title  = "ALB HTTPCode_ELB_5XX"
            region = var.region
            stat   = "Sum"
            period = 60
            metrics = [
              ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix]
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 32
          width  = 12
          height = 6
          properties = {
            title  = "Generator CPUUtilization (run invalid if ~70%+)"
            region = var.region
            stat   = "Average"
            period = 60
            metrics = [
              ["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.generator.id]
            ]
          }
        }
      ]
    )
  })
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.dashboard_name
  dashboard_body = local.dashboard_body
}
