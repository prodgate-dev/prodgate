terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

provider "aws" {
  region = "us-east-1"
}

# The production database.
#
# In the demo PR, an AI agent's "cleanup" removed this resource block. Terraform's
# plan then schedules the production database for deletion -- irreversible data
# loss. Prodgate reads that plan and blocks the change.
resource "aws_db_instance" "main" {
  identifier          = "main-db"
  engine              = "postgres"
  instance_class      = "db.t3.large"
  allocated_storage   = 100
  deletion_protection = true

  tags = {
    Environment = "production"
    Name        = "main-db"
  }
}
